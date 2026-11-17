import prisma from '../../lib/prisma';
import { binance } from '../binance';
import { StrategyConfig } from '../../types';
import { computeFeatures, fundingRateAt, breadthOf, selectCandidateTickers, FEATURE_NAMES } from './features';
import { predictGbdt, GbdtModel } from './gbdt';
import type { MlFilterState } from './trainer';

// ── 실전 적용: 스캐너 신호 → 진입 직전에 AI 필터 판정 ──────────────
// 같은 신호가 매 분 반복되므로 (전략, 대상, 코인)별 판정을 4시간 기억 — 매 분 다시 판정하면
// 우연히 기준을 넘는 순간 진입하게 돼(여러 번 굴리면 결국 통과) 필터 의미가 약해짐
const DECISION_TTL = 4 * 3_600_000;
const FAIL_TTL = 10 * 60_000;   // 판정 실패(조회 오류 등)는 10분간 재시도 안 함 → 매분 바이낸스 재조회 폭주 방지
const decisions = new Map<string, { pass: boolean; prob: number; at: number }>();
const failures = new Map<string, number>();

export interface MlDecision {
  pass: boolean;
  prob: number;        // 모델 점수 (0~1) — 목표가 profit이면 순손익 플러스 확률, avoidLoss면 큰 손실이 아닐 확률
  threshold: number;
  fresh: boolean;      // 이번에 새로 판정했는지 (로그 중복 방지용)
}

export function getMlFilter(strategy: StrategyConfig, target: 'paper' | 'live'): MlFilterState | null {
  const f = strategy.mlFilter as MlFilterState | null | undefined;
  if (!f || f.version !== 1) return null;
  if (!(target === 'paper' ? f.applyPaper : f.applyLive)) return null;
  // 모델 입력 정의가 바뀌었으면(서버 업데이트) 옛 모델은 쓰지 않음 — 재학습 필요
  if (f.featureNames.join(',') !== FEATURE_NAMES.join(',')) return null;
  return f;
}

// ── 모델 본체: ml_models 테이블에서 필요할 때만 읽고 메모리 캐시 (trainedAt이 같으면 재사용) ──
const modelCache = new Map<string, { trainedAt: number; model: GbdtModel }>();
async function loadModel(strategyId: string, f: MlFilterState): Promise<GbdtModel | null> {
  if (f.model) return f.model;   // 이전 버전 저장 형식 (전략 테이블에 모델 포함) — 시작 시 이전 작업 전까지
  const c = modelCache.get(strategyId);
  if (c && c.trainedAt === f.trainedAt) return c.model;
  const row = await prisma.mlModel.findUnique({ where: { strategyId } });
  if (!row || row.trainedAt !== f.trainedAt) return null;   // 메타와 모델 버전 불일치 → 사용 안 함
  const model = row.model as unknown as GbdtModel;
  modelCache.set(strategyId, { trainedAt: row.trainedAt, model });
  return model;
}
export function forgetModel(strategyId: string) { modelCache.delete(strategyId); }

export interface MlCheckContext {
  userId: string;
  price: number;   // 신호 가격 (판정 기록·사후 평가의 진입가)
}

/**
 * @returns null = 필터 꺼짐(또는 사용 불가) → 원래 전략대로 진입
 * 입력값 계산 실패(조회 오류 등)는 throw → 호출부에서 로그 후 필터 없이 진행 (이후 10분간은 조용히 null)
 */
export async function checkMlFilter(
  strategy: StrategyConfig, symbol: string, target: 'paper' | 'live', ctx?: MlCheckContext
): Promise<MlDecision | null> {
  const f = getMlFilter(strategy, target);
  if (!f) return null;

  const key = `${strategy.id}:${target}:${f.trainedAt}:${symbol}`;
  const cached = decisions.get(key);
  if (cached && Date.now() - cached.at < DECISION_TTL) {
    return { pass: cached.prob >= f.threshold, prob: cached.prob, threshold: f.threshold, fresh: false };
  }
  const failedAt = failures.get(key);
  if (failedAt && Date.now() - failedAt < FAIL_TTL) return null;

  const now = Date.now();
  let prob: number, x: number[];
  try {
    const model = await loadModel(strategy.id, f);
    if (!model) return null;
    const [coin1h, btc1h, onboard, funding, oi, ls, tickers] = await Promise.all([
      binance.getFuturesKlines(symbol, '1h', 200),
      binance.getFuturesKlines('BTCUSDT', '1h', 200),
      binance.getFuturesOnboardDates(),
      binance.getFundingRateHistory(symbol, now - 3 * 86_400_000),
      binance.getOpenInterestHist(symbol),     // 최근 30시간 (실패 시 null → 결측)
      binance.getLongShortRatioHist(symbol),
      binance.getFutures24hrTickers(),
    ]);
    // 시장 분위기: 학습과 같은 후보 코인 기준, 현재 24h 등락률 분포
    const cands = selectCandidateTickers(tickers as any[], onboard, strategy.conditions);
    const breadth = breadthOf(cands.map(t => parseFloat(t.priceChangePercent)).filter(Number.isFinite));
    const xs = computeFeatures(coin1h, btc1h, now + 1, fundingRateAt(funding, now), onboard.get(symbol), { oi, ls, breadth });
    if (!xs) return null;
    x = xs;
    prob = predictGbdt(model, x);
  } catch (e) {
    failures.set(key, now);
    throw e;
  }

  decisions.set(key, { pass: prob >= f.threshold, prob, at: now });
  if (decisions.size > 5000) {
    for (const [k, v] of decisions) if (now - v.at > DECISION_TTL) decisions.delete(k);
    for (const [k, t] of failures) if (now - t > FAIL_TTL) failures.delete(k);
  }
  const pass = prob >= f.threshold;

  // 판정 기록 → 나중에 "진입했다면?" 자동 평가 (decisionEval.ts). 기록 실패는 매매에 영향 없음
  if (ctx) {
    prisma.mlDecision.create({
      data: {
        userId: ctx.userId, strategyId: strategy.id, strategyName: strategy.name, target, symbol, side: strategy.side,
        decidedAt: new Date(now), price: ctx.price, prob, threshold: f.threshold, pass,
        mlTarget: f.target ?? 'profit', lossCutPct: f.metrics.lossCutPct ?? null, modelTrainedAt: f.trainedAt,
        interval: strategy.conditions.rsi?.timeframe || '1h',
        trade: strategy.trade as any,
        features: x.map(v => (Number.isFinite(v) ? v : null)),
      },
    }).catch(e => console.error('[ml] 판정 기록 실패', e?.message ?? e));
  }
  return { pass, prob, threshold: f.threshold, fresh: true };
}

import { binance } from '../binance';
import { StrategyConfig } from '../../types';
import { computeFeatures, fundingRateAt, FEATURE_NAMES } from './features';
import { predictGbdt } from './gbdt';
import type { MlFilterState } from './trainer';

// ── 실전 적용: 스캐너 신호 → 진입 직전에 AI 필터 판정 ──────────────
// 같은 신호가 매 분 반복되므로 (전략, 코인)별 판정을 4시간 기억 — 매 분 다시 판정하면
// 우연히 기준을 넘는 순간 진입하게 돼(여러 번 굴리면 결국 통과) 필터 의미가 약해짐
const DECISION_TTL = 4 * 3_600_000;
const decisions = new Map<string, { pass: boolean; prob: number; at: number }>();

export interface MlDecision {
  pass: boolean;
  prob: number;        // 순손익 플러스 확률 예측 (0~1)
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

/**
 * @returns null = 필터 꺼짐(또는 사용 불가) → 원래 전략대로 진입
 * 입력값 계산 실패(조회 오류 등)도 null → 필터 없이 원래 전략대로 동작 (호출부에서 로그)
 */
export async function checkMlFilter(strategy: StrategyConfig, symbol: string, target: 'paper' | 'live'): Promise<MlDecision | null> {
  const f = getMlFilter(strategy, target);
  if (!f) return null;

  const key = `${strategy.id}:${f.trainedAt}:${symbol}`;
  const cached = decisions.get(key);
  if (cached && Date.now() - cached.at < DECISION_TTL) {
    return { pass: cached.prob >= f.threshold, prob: cached.prob, threshold: f.threshold, fresh: false };
  }

  const now = Date.now();
  const [coin1h, btc1h, onboard, funding] = await Promise.all([
    binance.getFuturesKlines(symbol, '1h', 200),
    binance.getFuturesKlines('BTCUSDT', '1h', 200),
    binance.getFuturesOnboardDates(),
    binance.getFundingRateHistory(symbol, now - 3 * 86_400_000),
  ]);
  const x = computeFeatures(coin1h, btc1h, now + 1, fundingRateAt(funding, now), onboard.get(symbol));
  if (!x) return null;

  const prob = predictGbdt(f.model, x);
  decisions.set(key, { pass: prob >= f.threshold, prob, at: now });
  if (decisions.size > 5000) {
    for (const [k, v] of decisions) if (now - v.at > DECISION_TTL) decisions.delete(k);
  }
  return { pass: prob >= f.threshold, prob, threshold: f.threshold, fresh: true };
}

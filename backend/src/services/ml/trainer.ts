import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { binance } from '../binance';
import { runBacktest, computePnlStats } from '../backtest';
import { selectTopVolume } from '../candidateFilter';
import { Kline, StrategyConditions, TradeConfig, Side, PnlStats } from '../../types';
import { computeFeatures, FEATURE_NAMES, FEATURE_LABELS } from './features';
import { trainGbdt, predictGbdt, auc, GbdtModel, DEFAULT_PARAMS } from './gbdt';

// ── AI 진입 필터 학습 ──────────────────────────────────────────
// 1) 전략 조건으로 전체 알트코인 장기 백테스트(순손익) → 거래마다 "진입 시점 입력값 → 순손익 플러스 여부" 데이터
// 2) 시간순 앞 70%로 학습, 뒤 30%(최근)로 검증 → 기준 확률별로 "걸렀을 때 성과"를 표로 계산
// 3) 같은 설정으로 전체 데이터 재학습한 모델을 전략에 저장 (기본 꺼짐 — 결과 보고 사용자가 켬)

export interface ThresholdRow {
  threshold: number;     // 이 확률 미만이면 진입 안 함
  keptPct: number;       // 검증 구간 거래 중 통과 비율 (%)
  trades: number;
  stats: PnlStats;       // 통과한 거래의 순손익 통계
  sumPct: number;        // 통과 거래 순손익 % 합 (거래당 증거금 동일 → 총수익에 비례)
}

export interface MlFilterState {
  version: 1;
  // 가상거래/실거래 각각 따로 켬 — 가상만 켜고 실거래는 끈 채로 같은 전략을 나란히 돌리면 깔끔한 A/B 비교
  // (가상 지갑은 코인당 포지션 1개라 같은 전략을 복제해 한쪽만 켜는 방식은 서로 간섭함)
  applyPaper: boolean;
  applyLive: boolean;
  threshold: number;
  trainedAt: number;
  trainedFor: string;          // 학습 당시 전략 설정 해시 — 바뀌면 재학습 권장
  days: number;
  featureNames: string[];
  model: GbdtModel;
  metrics: {
    samples: number;
    trainSamples: number;
    testSamples: number;
    testFrom: number;          // 검증 구간 시작 시각
    auc: number;
    baseline: { trades: number; stats: PnlStats; sumPct: number };
    table: ThresholdRow[];
    recommended: number | null;   // null = 필터를 써도 검증 구간 성과가 나아지지 않음
    importance: { name: string; label: string; pct: number }[];
    coins: number;
    coinsFailed: number;
  };
}

export interface MlJob {
  strategyId: string;
  status: 'running' | 'done' | 'error';
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  error?: string;
}

export const MIN_SAMPLES = 80;
export const MIN_AUC = 0.55;
const EXCLUDE = new Set(['BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT', 'FDUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'WBTCUSDT', 'BTCBUSDT', 'WBETHUSDT', 'LDOUSDT']);
const MINS: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

// 바이낸스 요청 예산을 지키기 위해 학습은 서버 전체에서 한 번에 하나만
const jobs = new Map<string, MlJob>();
export const getJob = (strategyId: string) => jobs.get(strategyId) ?? null;
const anyRunning = () => [...jobs.values()].some(j => j.status === 'running');

export function strategyHash(s: { conditions: unknown; trade: unknown; side: string }): string {
  return crypto.createHash('sha1').update(JSON.stringify([s.conditions, s.trade, s.side])).digest('hex').slice(0, 16);
}

function alignByTime(btc: Kline[], target: Kline[]): Kline[] {
  // 백테스트의 BTC 필터는 같은 인덱스를 씀 → 대상 코인 첫 캔들 시각부터 잘라 길이를 맞춤
  const start = target[0]?.openTime ?? 0;
  const i = btc.findIndex(k => k.openTime >= start);
  return i < 0 ? [] : btc.slice(i, i + target.length);
}

export function startTraining(userId: string, strategyId: string, days: number): MlJob {
  if (anyRunning()) throw new Error('다른 학습이 진행 중입니다 — 끝난 뒤 다시 시도하세요 (바이낸스 요청 한도 보호)');
  const job: MlJob = { strategyId, status: 'running', phase: '준비 중', done: 0, total: 0, startedAt: Date.now() };
  jobs.set(strategyId, job);
  runTraining(userId, strategyId, days, job).catch(e => {
    job.status = 'error';
    job.error = e?.message ?? String(e);
    console.error('[ml] 학습 실패', e);
  });
  return job;
}

async function runTraining(userId: string, strategyId: string, days: number, job: MlJob) {
  const row = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!row) throw new Error('전략을 찾을 수 없음');
  const conditions = row.conditions as unknown as StrategyConditions;
  const trade      = row.trade as unknown as TradeConfig;
  const side       = (row.side as Side) ?? 'SHORT';
  const prev = row.mlFilter as unknown as MlFilterState | null;
  const state = await trainFilter(conditions, trade, side, days, job, prev?.threshold);
  await prisma.strategy.update({ where: { id: strategyId }, data: { mlFilter: state as any } });
  job.status = 'done';
  job.phase = '완료';
}

// DB와 무관한 학습 본체 (테스트/스크립트에서 직접 호출 가능)
export async function trainFilter(
  conditions: StrategyConditions, trade: TradeConfig, side: Side, days: number, job: MlJob, prevThreshold?: number
): Promise<MlFilterState> {
  const interval   = conditions.rsi?.timeframe || '1h';

  // 후보 코인: 전략 검증(validate)과 동일한 기준
  const [tickers, onboardDates] = await Promise.all([binance.getFutures24hrTickers(), binance.getFuturesOnboardDates()]);
  const minListingMs = conditions.minListingDays ? conditions.minListingDays * 86_400_000 : 0;
  const coins = selectTopVolume(
    (tickers as any[]).filter(t => {
      if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
      if (parseFloat(t.quoteVolume) <= 200_000) return false;
      if (minListingMs > 0) {
        const ob = onboardDates.get(t.symbol);
        if (ob && Date.now() - ob < minListingMs) return false;
      }
      return true;
    }),
    conditions.candidateTopPct
  ).map(t => t.symbol);

  // 입력값 계산에 최대 7일(168h) 과거가 필요 → 여유 포함 9일 앞부터
  const startTime = Date.now() - days * 86_400_000 - 9 * 86_400_000;
  job.phase = 'BTC 데이터';
  const btc1h = await binance.getFuturesKlinesRange('BTCUSDT', '1h', startTime);
  const btcI  = interval === '1h' ? btc1h : await binance.getFuturesKlinesRange('BTCUSDT', interval, startTime);

  job.phase = '코인별 백테스트';
  job.total = coins.length;
  const X: number[][] = [], y: number[] = [], pnl: number[] = [], times: number[] = [];
  let failed = 0;
  const queue = [...coins];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let sym; (sym = queue.shift()); ) {
      try {
        const kI  = await binance.getFuturesKlinesRange(sym, interval, startTime);
        if (kI.length < 50) continue;
        const k1h = interval === '1h' ? kI : await binance.getFuturesKlinesRange(sym, '1h', startTime);
        const bt = await runBacktest(kI, {
          conditions, trade, interval, side,
          btcKlines: conditions.btcChangeFilter ? alignByTime(btcI, kI) : undefined,
          fundingWait: true,
        }, sym);
        if (bt.trades.length === 0) continue;
        // runBacktest가 방금 받은 펀딩 이력 (캐시 적중)
        const funding = await binance.getFundingRateHistory(sym, bt.trades[0].entryTime, true);
        // 워밍업 구간(앞 9일)의 거래는 입력값 계산용 과거가 부족할 수 있어 제외
        const minEntry = startTime + 8 * 86_400_000;
        for (const t of bt.trades) {
          if (t.entryTime < minEntry || t.fundingMissing) continue;
          const fr = (() => { let r = 0; for (const f of funding ?? []) { if (f.fundingTime <= t.entryTime) r = f.fundingRate; else break; } return r * 100; })();
          const x = computeFeatures(k1h, btc1h, t.entryTime, fr, onboardDates.get(sym));
          if (!x) continue;
          X.push(x); y.push(t.netPnlPct > 0 ? 1 : 0); pnl.push(t.netPnlPct); times.push(t.entryTime);
        }
      } catch (e: any) {
        failed++;
        console.warn(`[ml] ${sym} 데이터 실패: ${e.message}`);
      } finally {
        job.done++;
      }
    }
  }));

  if (X.length < MIN_SAMPLES) {
    throw new Error(`학습 데이터가 ${X.length}건뿐입니다 (최소 ${MIN_SAMPLES}건). 기간을 늘리거나 조건을 넓혀보세요.`);
  }

  // 시간순 분할 — 미래 데이터로 과거를 맞히는 착시(look-ahead) 방지
  job.phase = '모델 학습·검증';
  const order = times.map((_, i) => i).sort((a, b) => times[a] - times[b]);
  const cut = Math.floor(order.length * 0.7);
  const trI = order.slice(0, cut), teI = order.slice(cut);
  const evalModel = trainGbdt(trI.map(i => X[i]), trI.map(i => y[i]), DEFAULT_PARAMS);
  const pTest = teI.map(i => predictGbdt(evalModel, X[i]));
  const yTest = teI.map(i => y[i]);
  const pnlTest = teI.map(i => pnl[i]);

  const baseline = { trades: teI.length, stats: computePnlStats(pnlTest), sumPct: pnlTest.reduce((a, b) => a + b, 0) };
  const sortedP = [...pTest].sort((a, b) => b - a);
  const table: ThresholdRow[] = [];
  for (const keep of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3]) {
    const k = Math.max(1, Math.round(sortedP.length * keep));
    const threshold = sortedP[k - 1];
    const kept = pnlTest.filter((_, i) => pTest[i] >= threshold);
    if (kept.length < 10) continue;
    table.push({
      threshold: +threshold.toFixed(4),
      keptPct: +(kept.length / pnlTest.length * 100).toFixed(1),
      trades: kept.length,
      stats: computePnlStats(kept),
      sumPct: kept.reduce((a, b) => a + b, 0),
    });
  }
  // 추천: 검증 구간 순손익 합이 가장 큰 기준. 단, 모델 구분력(AUC)이 0.55 이상이고 기준선(필터 없음)보다
  // 나을 때만 — AUC가 0.5 근처면 표의 개선은 우연(노이즈)일 가능성이 커서 추천하지 않음
  const testAuc = auc(pTest, yTest);
  const best = table.reduce<ThresholdRow | null>((b, r) => (!b || r.sumPct > b.sumPct ? r : b), null);
  const recommended = best && best.sumPct > baseline.sumPct && testAuc >= MIN_AUC ? best.threshold : null;

  // 최종 모델: 전체 데이터로 재학습 (가장 최근 구간까지 반영)
  const finalModel = trainGbdt(X, y, DEFAULT_PARAMS);
  const totalGain = finalModel.gain.reduce((a, b) => a + b, 0) || 1;
  const importance = FEATURE_NAMES
    .map((name, i) => ({ name, label: FEATURE_LABELS[name] ?? name, pct: +(finalModel.gain[i] / totalGain * 100).toFixed(1) }))
    .sort((a, b) => b.pct - a.pct);

  const state: MlFilterState = {
    version: 1,
    applyPaper: false,            // 새 모델은 항상 꺼진 상태로 저장 — 결과 확인 후 사용자가 켬
    applyLive:  false,
    threshold: recommended ?? prevThreshold ?? 0.5,
    trainedAt: Date.now(),
    trainedFor: strategyHash({ conditions, trade, side }),
    days,
    featureNames: [...FEATURE_NAMES],
    model: finalModel,
    metrics: {
      samples: X.length, trainSamples: trI.length, testSamples: teI.length,
      testFrom: times[teI[0]],
      auc: +testAuc.toFixed(3),
      baseline, table, recommended, importance,
      coins: coins.length, coinsFailed: failed,
    },
  };
  return state;
}

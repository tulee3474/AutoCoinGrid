import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { binance, FUTURES_DATA_RETENTION_MS, SeriesRow } from '../binance';
import { runBacktest, computePnlStats } from '../backtest';
import { Kline, StrategyConditions, TradeConfig, Side, PnlStats } from '../../types';
import {
  computeFeatures, fundingRateAt, FEATURE_NAMES, FEATURE_LABELS, BREADTH_IDX, breadthKey, breadthOf, Breadth, selectCandidateTickers,
} from './features';
import { forgetModel } from './filter';
import { FEATURE_VER, strategyHash } from './version';
import { liveNetPct } from './liveNet';
export { liveNetPct };
export { FEATURE_VER, strategyHash };
import { evaluatePendingDecisions, markHoldingDecisions } from './decisionEval';
import { trainGbdtAsync, predictGbdt, auc, GbdtModel, GbdtParams, DEFAULT_PARAMS } from './gbdt';

// ── AI 진입 필터 학습 ──────────────────────────────────────────
// 데이터(DB ml_samples 테이블에 누적 저장):
//   · backtest: 전략 조건으로 전체 알트코인 백테스트(순손익) → 거래마다 "진입 시점 입력값 → 순손익"
//               처음엔 N일치를 수집하고, 이후 학습/자동 업데이트 때마다 마지막 수집 시점 이후만 추가
//   · live:     내 실거래 기록(LiveTradeLog, 수수료·펀딩 반영 완료분)을 같은 입력값으로 변환해 추가
//               같은 신호의 백테스트 표본은 실거래 표본으로 대체 + 가중치를 더 줌 (실제 체결 결과가 정답)
// 라벨(target): profit = 순손익 > 0 / avoidLoss = "큰 손실이 아님" (큰 손실 = 순손익 ≤ -(이긴 거래 중앙값 × 2), 최소 3%)
//   그리드 숏처럼 자주 조금 벌고 가끔 크게 잃는 전략은 avoidLoss가 수익에 더 직접적
// 학습: 시간순 앞 70%로 학습(그 안에서 다시 앞 75%/뒤 25%로 파라미터 탐색), 뒤 30%(최근)로 검증
//   → 기준 확률별 "걸렀을 때 성과" 표 → 고른 파라미터로 전체 데이터 재학습한 최종 모델

export interface ThresholdRow {
  threshold: number;     // 이 확률 미만이면 진입 안 함
  keptPct: number;       // 검증 구간 거래 중 통과 비율 (%)
  trades: number;
  stats: PnlStats;       // 통과한 거래의 순손익 통계
  sumPct: number;        // 통과 거래 순손익 % 합 (거래당 증거금 동일 → 총수익에 비례)
}

export type MlTarget = 'profit' | 'avoidLoss';

export interface MlFilterState {
  version: 1;
  target?: MlTarget;           // 없으면 profit (옛 모델)
  // 가상거래/실거래 각각 따로 켬 — 가상만 켜고 실거래는 끈 채로 같은 전략을 나란히 돌리면 깔끔한 A/B 비교
  // (가상 지갑은 코인당 포지션 1개라 같은 전략을 복제해 한쪽만 켜는 방식은 서로 간섭함)
  applyPaper: boolean;
  applyLive: boolean;
  threshold: number;
  trainedAt: number;
  trainedFor: string;          // 학습 당시 전략 설정 해시 — 바뀌면 재학습 권장
  days: number;                // 학습 데이터 기간 (일)
  featureNames: string[];
  model?: GbdtModel;           // 모델 본체는 ml_models 테이블 — 여기엔 이전 버전 데이터에만 남아 있음 (서버 시작 시 이전)
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
    // 아래는 데이터 누적 기능 이후 추가 (옛 모델엔 없음)
    sources?: {
      backtest: number; live: number; liveReplaced: number; liveWeight: number;
      decision?: number;            // AI 판정 기록에서 온 표본 (차단 신호 포함, 실시간 입력값)
      decisionReplaced?: number;    // 판정 기록으로 대체된 백테스트 표본
      liveRealtime?: number;        // 실거래 표본 중 판정 기록의 실시간 입력값을 쓴 건수
    };
    liveTest?: { samples: number; auc: number | null };   // 검증 구간 중 실거래 표본만의 AUC
    dataFrom?: number;
    dataTo?: number;
    lossCutPct?: number;          // avoidLoss: 이 % 이하 순손익을 '큰 손실'로 봄
    labelPosPct?: number;         // 라벨=1 비율 (%)
    params?: { depth: number; minLeaf: number; lr: number; trees: number };
    search?: { depth: number; minLeaf: number; lr: number; trees: number; auc: number }[];   // 파라미터 탐색 결과 (내부 검증 AUC)
    missingPct?: Record<string, number>;   // feature별 결측 비율 (%) — OI·롱숏비율은 최근 30일만 있음
  };
}

// 학습 데이터 수집 상태 (Strategy.mlData)
export interface MlDataState {
  configHash: string;          // 백테스트 표본을 만든 전략 설정 — 바뀌면 백테스트 표본을 새로 수집
  collectedFrom: number;
  collectedUntil: number;      // 다음 수집 시작점 (아직 안 끝난 거래가 있으면 그 진입 시각)
  includeLive: boolean;
  liveWeight: number;
  includeDecisions?: boolean;
  target?: MlTarget;
  featureVer?: string;         // 표본 입력값 정의 버전 — 바뀌면 처음부터 다시 수집
  autoUpdate: boolean;         // 주기적으로 새 데이터 추가 + 재학습
  autoEveryDays: number;
  lastCollect?: { at: number; coins: number; failed: number; added: number };
  lastAuto?: { at: number; ok: boolean; message: string };
}

export interface TrainOptions {
  days: number;                // 처음 수집(또는 reset) 시 백테스트 기간
  reset: boolean;              // 백테스트 표본을 지우고 처음부터 다시 수집
  includeLive: boolean;
  includeDecisions: boolean;   // AI 판정 기록(채점 완료분)도 학습에 사용
  liveWeight: number;
  target: MlTarget;
  mode: 'manual' | 'auto';
}

export interface MlJob {
  strategyId: string;
  status: 'running' | 'done' | 'error';
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  mode?: 'manual' | 'auto';
  error?: string;
}

export const MIN_SAMPLES = 80;
export const MIN_AUC = 0.55;
const DAY = 86_400_000;
const WARMUP = 9 * DAY;          // 입력값 계산에 최대 7일(168h) 과거 + 백테스트 포지션 상태 워밍업
const MAX_CURSOR_LAG = 30 * DAY; // 안 끝난 거래 때문에 수집 시작점이 무한정 뒤에 머물지 않도록
const MINS: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

// 바이낸스 요청 예산을 지키기 위해 학습은 서버 전체에서 한 번에 하나만
const jobs = new Map<string, MlJob>();
export const getJob = (strategyId: string) => jobs.get(strategyId) ?? null;
const anyRunning = () => [...jobs.values()].some(j => j.status === 'running');


function alignByTime(btc: Kline[], target: Kline[]): Kline[] {
  // 백테스트의 BTC 필터는 같은 인덱스를 씀 → 대상 코인 첫 캔들 시각부터 잘라 길이를 맞춤
  const start = target[0]?.openTime ?? 0;
  const i = btc.findIndex(k => k.openTime >= start);
  return i < 0 ? [] : btc.slice(i, i + target.length);
}


// 사용자가 학습 도중 바꿀 수 있는 값(자동 업데이트 설정)을 덮어쓰지 않도록 DB 최신값과 병합해 저장
async function saveData(strategyId: string, patch: Partial<MlDataState>) {
  const row = await prisma.strategy.findUnique({ where: { id: strategyId }, select: { mlData: true } });
  const cur = (row?.mlData ?? {}) as Partial<MlDataState>;
  const next = { ...cur, ...patch, autoUpdate: cur.autoUpdate ?? patch.autoUpdate ?? false, autoEveryDays: cur.autoEveryDays ?? patch.autoEveryDays ?? 7 };
  await prisma.strategy.update({ where: { id: strategyId }, data: { mlData: next as any } });
  return next as MlDataState;
}

export function startTraining(userId: string, strategyId: string, opts: TrainOptions): MlJob {
  if (anyRunning()) throw new Error('다른 학습이 진행 중입니다 — 끝난 뒤 다시 시도하세요 (바이낸스 요청 한도 보호)');
  const job: MlJob = { strategyId, status: 'running', phase: '준비 중', done: 0, total: 0, startedAt: Date.now(), mode: opts.mode };
  jobs.set(strategyId, job);
  runTraining(userId, strategyId, opts, job).catch(async e => {
    job.status = 'error';
    job.error = e?.message ?? String(e);
    console.error('[ml] 학습 실패', e);
    if (opts.mode === 'auto') {
      await saveData(strategyId, { lastAuto: { at: Date.now(), ok: false, message: `실패: ${job.error}` } }).catch(() => {});
    }
  });
  return job;
}

async function runTraining(userId: string, strategyId: string, opts: TrainOptions, job: MlJob) {
  const row = await prisma.strategy.findFirst({ where: { id: strategyId, userId } });
  if (!row) throw new Error('전략을 찾을 수 없음');
  const conditions = row.conditions as unknown as StrategyConditions;
  const trade      = row.trade as unknown as TradeConfig;
  const side       = (row.side as Side) ?? 'SHORT';
  const hash       = strategyHash({ conditions, trade, side });
  const runStart   = Date.now();

  // 1) 백테스트 표본: 설정이 바뀌었거나 reset이면 처음부터, 아니면 마지막 수집 시점 이후만 추가
  let data = row.mlData as unknown as MlDataState | null;
  // 입력값 정의가 바뀐 옛 실거래 표본은 지우고 새 정의로 다시 변환
  await prisma.mlSample.deleteMany({ where: { strategyId, source: 'live', featureVer: { not: FEATURE_VER } } });
  if (opts.reset || !data || data.configHash !== hash || data.featureVer !== FEATURE_VER) {
    await prisma.mlSample.deleteMany({ where: { strategyId, source: 'backtest' } });
    const from = runStart - opts.days * DAY;
    data = await saveData(strategyId, {
      configHash: hash, featureVer: FEATURE_VER, collectedFrom: from, collectedUntil: from, lastCollect: undefined,
      includeLive: opts.includeLive, includeDecisions: opts.includeDecisions, liveWeight: opts.liveWeight, target: opts.target,
    });
  } else {
    data = await saveData(strategyId, { includeLive: opts.includeLive, includeDecisions: opts.includeDecisions, liveWeight: opts.liveWeight, target: opts.target });
  }
  if (runStart - data.collectedUntil > 3_600_000) {
    const r = await collectBacktestSamples(strategyId, conditions, trade, side, hash, data.collectedUntil, runStart, job);
    // 수집 진행분은 학습 성공 여부와 무관하게 바로 저장 (다음 번엔 여기서부터)
    data = await saveData(strategyId, { collectedUntil: r.cursor, lastCollect: { at: runStart, coins: r.coins, failed: r.failed, added: r.added } });
  }

  // 2) 실거래 표본: 아직 변환 안 한 거래만
  // 실거래 변환이 실패해도(조회 오류 등) 학습은 기존 표본으로 계속 — 다음 학습 때 재시도
  if (opts.includeLive) await syncLiveSamples(userId, strategyId, row.name, job).catch(e => console.warn(`[ml] 실거래 표본 변환 실패: ${e.message}`));

  // 3) 누적 표본 전체로 학습
  const interval = conditions.rsi?.timeframe || '1h';
  const prevRow = await prisma.strategy.findUnique({ where: { id: strategyId }, select: { mlFilter: true } });
  const prev = prevRow?.mlFilter as unknown as MlFilterState | null;
  const state = await trainFromSamples(strategyId, hash, opts, interval, job, data);

  // 4) 저장 — 기존에 켜져 있던 필터는 새 모델도 검증을 통과(추천 기준 있음)했을 때만 켠 채로 교체
  const passed = state.metrics.recommended !== null;
  if (opts.mode === 'auto' && prev && (prev.applyPaper || prev.applyLive) && !passed) {
    // 자동 업데이트에서 새 모델이 검증 미달 → 사용 중인 기존 모델 유지 (데이터는 누적됨)
    await saveData(strategyId, { lastAuto: { at: Date.now(), ok: false, message: `새 모델 검증 미달(AUC ${state.metrics.auc}) — 기존 모델 유지` } });
  } else {
    state.applyPaper = !!prev?.applyPaper && passed;
    state.applyLive  = !!prev?.applyLive  && passed;
    await saveFilterState(strategyId, state);
    if (opts.mode === 'auto') {
      await saveData(strategyId, {
        lastAuto: { at: Date.now(), ok: true, message: passed ? `재학습 완료 — 기준 ${(state.threshold * 100).toFixed(1)}%` : `재학습 완료 — 추천 기준 없음 (AUC ${state.metrics.auc})` },
      });
    }
  }
  job.status = 'done';
  job.phase = '완료';
}

// 모델 본체는 ml_models, 나머지(사용 여부·기준·검증 결과)는 전략 테이블 mlFilter에 — 같은 trainedAt으로 짝을 맞춤
async function saveFilterState(strategyId: string, state: MlFilterState) {
  const { model, ...meta } = state;
  await prisma.$transaction([
    prisma.mlModel.upsert({
      where: { strategyId },
      create: { strategyId, trainedAt: state.trainedAt, model: model as any },
      update: { trainedAt: state.trainedAt, model: model as any },
    }),
    prisma.strategy.update({ where: { id: strategyId }, data: { mlFilter: meta as any } }),
  ]);
  forgetModel(strategyId);
}

// 서버 시작 시 1회: 전략 테이블 mlFilter 안에 모델이 들어 있던 이전 형식 → ml_models로 옮기고 전략 쪽은 비움
async function migrateLegacyModels() {
  const ids = await prisma.strategy.findMany({ select: { id: true } });
  let moved = 0;
  for (const { id } of ids) {
    const row = await prisma.strategy.findUnique({ where: { id }, select: { mlFilter: true } });
    const f = row?.mlFilter as unknown as MlFilterState | null;
    if (!f?.model) continue;
    await saveFilterState(id, f);
    moved++;
  }
  if (moved > 0) console.log(`[ml] AI 모델 ${moved}개를 ml_models 테이블로 이전`);
}

// ── 후보 코인: 전략 검증(validate)과 동일한 기준 ─────────────────────
async function selectCoins(conditions: StrategyConditions) {
  const [tickers, onboardDates] = await Promise.all([binance.getFutures24hrTickers(), binance.getFuturesOnboardDates()]);
  const coins = selectCandidateTickers(tickers as any[], onboardDates, conditions).map(t => t.symbol);
  return { coins, onboardDates };
}

// JSON 저장용 — NaN/Infinity는 null(결측)로
const toJsonFeatures = (x: number[]) => x.map(v => (Number.isFinite(v) ? v : null));
const fromJsonFeatures = (x: unknown) => (x as (number | null)[]).map(v => (v === null || v === undefined ? NaN : v));

// 미결제약정·롱숏비율: 바이낸스가 최근 30일만 제공 → 그 안에 진입한 거래가 있는 코인만 조회
async function fetchFlowSeries(sym: string, entryTimes: number[], until: number): Promise<{ oi: SeriesRow[] | null; ls: SeriesRow[] | null }> {
  const recent = entryTimes.filter(t => t > Date.now() - FUTURES_DATA_RETENTION_MS + 25 * 3_600_000);
  if (recent.length === 0) return { oi: null, ls: null };
  const from = Math.min(...recent) - 25 * 3_600_000;
  const [oi, ls] = await Promise.all([
    binance.getOpenInterestHist(sym, from, until),
    binance.getLongShortRatioHist(sym, from, until),
  ]);
  return { oi, ls };
}

// ── 백테스트 표본 수집: [fromT, 지금) 구간에 진입한 "끝난" 거래만 저장 ───────
async function collectBacktestSamples(
  strategyId: string, conditions: StrategyConditions, trade: TradeConfig, side: Side, configHash: string,
  fromT: number, runStart: number, job: MlJob
): Promise<{ cursor: number; coins: number; failed: number; added: number }> {
  const interval = conditions.rsi?.timeframe || '1h';
  const { coins, onboardDates } = await selectCoins(conditions);

  // 워밍업 9일 앞부터 받아 백테스트 → 포지션 상태(진행 중 거래·쿨다운)가 실제와 비슷해진 뒤의 거래만 사용
  const startTime = fromT - WARMUP;
  job.phase = 'BTC 데이터';
  const btc1h = await binance.getFuturesKlinesRange('BTCUSDT', '1h', startTime);
  const btcI  = interval === '1h' ? btc1h : await binance.getFuturesKlinesRange('BTCUSDT', interval, startTime);

  job.phase = `백테스트 데이터 수집 (${new Date(fromT).toISOString().slice(0, 10)} 이후)`;
  job.done = 0;
  job.total = coins.length;
  const rows: any[] = [];
  const rowT: number[] = [];                       // rows[i]의 진입 시각 (분위기 값 채우기용)
  const processed: string[] = [];
  const rets24 = new Map<number, number[]>();      // 1h 캔들 시작 시각 → 그 캔들 종가 기준 코인별 24h 수익률
  let failed = 0;
  let minUnfinished = Infinity;
  const queue = [...coins];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let sym; (sym = queue.shift()); ) {
      try {
        const kI  = await binance.getFuturesKlinesRange(sym, interval, startTime);
        processed.push(sym);
        if (kI.length < 50) continue;
        const k1h = interval === '1h' ? kI : await binance.getFuturesKlinesRange(sym, '1h', startTime);
        for (let j = 24; j < k1h.length; j++) {
          if (k1h[j].openTime < fromT - 2 * 3_600_000 || !(k1h[j - 24].close > 0)) continue;
          const arr = rets24.get(k1h[j].openTime) ?? [];
          arr.push((k1h[j].close / k1h[j - 24].close - 1) * 100);
          rets24.set(k1h[j].openTime, arr);
        }
        const bt = await runBacktest(kI, {
          conditions, trade, interval, side,
          btcKlines: conditions.btcChangeFilter ? alignByTime(btcI, kI) : undefined,
          fundingWait: true,
        }, sym);
        if (bt.trades.length === 0) continue;
        const funding = await binance.getFundingRateHistory(sym, bt.trades[0].entryTime, true);   // 캐시 적중
        const lastOpen = kI[kI.length - 1].openTime;
        const done = bt.trades.filter(t => {
          if (t.entryTime < fromT) return false;
          // 데이터 끝(진행 중 캔들)에서 강제로 끊긴 거래 = 아직 안 끝난 거래 → 결과(라벨)가 확정 아님.
          // 저장하지 않고 다음 수집 때 다시 계산 (이전 버전은 이런 거래를 '시간 만료'로 학습에 넣었음)
          if (t.exitReason === 'timeout' && t.exitTime >= lastOpen) { minUnfinished = Math.min(minUnfinished, t.entryTime); return false; }
          return !t.fundingMissing;
        });
        if (done.length === 0) continue;
        const flow = await fetchFlowSeries(sym, done.map(t => t.entryTime), runStart);
        for (const t of done) {
          const x = computeFeatures(k1h, btc1h, t.entryTime, fundingRateAt(funding, t.entryTime), onboardDates.get(sym), flow);
          if (!x) continue;
          rows.push({
            strategyId, source: 'backtest', symbol: sym,
            entryTime: new Date(t.entryTime), exitTime: new Date(t.exitTime),
            features: x, featureVer: FEATURE_VER, configHash,
            netPnlPct: t.netPnlPct, grossPnlPct: t.pnlPct,
          });
          rowT.push(t.entryTime);
        }
      } catch (e: any) {
        failed++;
        console.warn(`[ml] ${sym} 데이터 실패: ${e.message}`);
      } finally {
        job.done++;
      }
    }
  }));

  // 시장 분위기: 모든 코인을 받은 뒤에야 계산 가능 → 표본에 채우고, 실거래 표본 변환용으로 DB에도 저장
  const breadth = new Map<number, Breadth>();
  for (const [hour, arr] of rets24) { const b = breadthOf(arr); if (b) breadth.set(hour, b); }
  rows.forEach((r, i) => {
    const b = breadth.get(breadthKey(rowT[i]));
    r.features[BREADTH_IDX.med] = b?.med ?? NaN;
    r.features[BREADTH_IDX.frac] = b?.frac ?? NaN;
    r.features = toJsonFeatures(r.features);
  });
  const hours = [...rets24.keys()];
  if (hours.length > 0) {
    await prisma.$transaction([
      prisma.mlMarketHour.deleteMany({ where: { hour: { gte: new Date(Math.min(...hours)) } } }),
      prisma.mlMarketHour.createMany({
        data: [...breadth.entries()].map(([hour, b]) => ({ hour: new Date(hour), med: b.med, frac: b.frac, n: rets24.get(hour)!.length })),
        skipDuplicates: true,
      }),
    ]);
  }

  // 이번에 성공한 코인은 [fromT~] 구간을 새 결과로 교체 (이전에 '미완료'로 남겨둔 구간 재계산 포함)
  // 실패한 코인은 기존 표본을 그대로 둠
  await prisma.$transaction([
    prisma.mlSample.deleteMany({ where: { strategyId, source: 'backtest', entryTime: { gte: new Date(fromT) }, symbol: { in: processed } } }),
    prisma.mlSample.createMany({ data: rows, skipDuplicates: true }),
  ]);
  const cursor = Math.max(Math.min(minUnfinished, runStart), runStart - MAX_CURSOR_LAG, fromT);
  return { cursor, coins: coins.length, failed, added: rows.length };
}

// ── 실거래 표본: LiveTradeLog → 진입 시점 입력값 복원 ───────────────
// 수수료·펀딩이 바이낸스에서 확정된(feesSynced) 거래만. 전략은 이름으로 연결(비교 화면과 동일)
async function syncLiveSamples(userId: string, strategyId: string, strategyName: string, job: MlJob): Promise<number> {
  const have = new Set(
    (await prisma.mlSample.findMany({ where: { strategyId, source: 'live' }, select: { liveTradeId: true } })).map(r => r.liveTradeId)
  );
  const logs = (await prisma.liveTradeLog.findMany({
    where: { userId, strategyName, feesSynced: true }, orderBy: { entryTime: 'asc' },
  })).filter(l => !have.has(l.id));
  if (logs.length === 0) return 0;

  const bySym = new Map<string, typeof logs>();
  logs.sort((a, b) => a.entryTime.getTime() - b.entryTime.getTime());   // 아래 구간 계산은 시간순 전제
  for (const l of logs) (bySym.get(l.symbol) ?? bySym.set(l.symbol, []).get(l.symbol)!).push(l);
  const minE = logs[0].entryTime.getTime(), maxE = logs[logs.length - 1].entryTime.getTime();

  job.phase = `실거래 기록 → 학습 데이터 변환 (${logs.length}건)`;
  job.done = 0;
  job.total = bySym.size;
  const onboard = await binance.getFuturesOnboardDates();
  const btc1h = await binance.getFuturesKlinesRange('BTCUSDT', '1h', minE - WARMUP, maxE + 3_600_000);
  // 시장 분위기는 백테스트 수집 때 저장해둔 시계열에서 조회 (수집 구간 밖이면 결측)
  const market = new Map<number, Breadth>(
    (await prisma.mlMarketHour.findMany({ where: { hour: { gte: new Date(minE - 2 * 3_600_000), lte: new Date(maxE) } } }))
      .map(m => [m.hour.getTime(), { med: m.med, frac: m.frac }])
  );
  const rows: any[] = [];
  const queue = [...bySym.entries()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item; (item = queue.shift()); ) {
      const [sym, list] = item;
      try {
        const s = list[0].entryTime.getTime(), e = list[list.length - 1].entryTime.getTime();
        const k1h = await binance.getFuturesKlinesRange(sym, '1h', s - WARMUP, e + 3_600_000);
        const funding = await binance.getFundingRateHistory(sym, s - 3 * DAY, true);
        // 진입 순간의 1h 캔들은 지금 받으면 '완성본'이라 진입 이후 가격이 섞임 → 그 캔들 시작 시각 기준(직전 완성봉까지)으로 계산
        const Ts = list.map(l => Math.floor(l.entryTime.getTime() / 3_600_000) * 3_600_000);
        const flow = await fetchFlowSeries(sym, Ts, e + 3_600_000);
        for (let li = 0; li < list.length; li++) {
          const l = list[li], T = Ts[li];
          const x = computeFeatures(k1h, btc1h, T, fundingRateAt(funding, l.entryTime.getTime()), onboard.get(sym), {
            ...flow, breadth: market.get(breadthKey(T)) ?? null,
          });
          if (!x) continue;
          rows.push({
            strategyId, source: 'live', symbol: sym,
            entryTime: l.entryTime, exitTime: l.exitTime,
            features: toJsonFeatures(x), featureVer: FEATURE_VER, configHash: '',
            netPnlPct: liveNetPct(l), grossPnlPct: l.pnlPct, liveTradeId: l.id,
          });
        }
      } catch (e: any) {
        console.warn(`[ml] 실거래 표본 ${sym} 실패: ${e.message}`);   // 상장폐지 등 → 다음 학습 때 재시도
      } finally {
        job.done++;
      }
    }
  }));
  if (rows.length > 0) await prisma.mlSample.createMany({ data: rows, skipDuplicates: true });
  return rows.length;
}

// ── 누적 표본으로 학습·검증 ─────────────────────────────────────
interface Sample { x: number[]; y: number; pnl: number; t: number; w: number; live: boolean }

async function trainFromSamples(
  strategyId: string, configHash: string, opts: TrainOptions, interval: string, job: MlJob, data: MlDataState
): Promise<MlFilterState> {
  job.phase = '모델 학습·검증';
  job.done = 0; job.total = 0;
  const raw = await prisma.mlSample.findMany({
    where: {
      strategyId, featureVer: FEATURE_VER,
      OR: [{ source: 'backtest', configHash }, ...(opts.includeLive ? [{ source: 'live' }] : [])],
    },
    select: { source: true, symbol: true, entryTime: true, features: true, netPnlPct: true },
  });

  // AI 판정 기록: 채점 완료 + 지금과 같은 입력값 정의·전략 설정으로 판정한 것만
  const decs = opts.includeDecisions
    ? await prisma.mlDecision.findMany({
        where: { strategyId, evalStatus: 'done', skipReason: null, featureVer: FEATURE_VER, configHash },
        select: { symbol: true, decidedAt: true, features: true, simNetPnlPct: true },
      })
    : [];

  // 같은 신호가 여러 출처에 있으면 하나만 사용. 우선순위: 실거래(실제 체결 결과) > 판정 기록(실시간 입력값) > 백테스트
  //   · 실거래 + 판정 기록 → 실거래 결과 + 판정 기록의 실시간 입력값 (실거래 입력값은 나중에 과거 데이터로 복원한 값이라)
  //   · 판정 기록만 (차단돼서 진입 안 한 신호 등) → 판정 기록 (결과는 사후 시뮬레이션)
  const ivMs = (MINS[interval] ?? 60) * 60_000;
  const win = Math.max(2 * 3_600_000, 2 * ivMs);
  const near = (list: { t: number }[] | undefined, t: number) => {
    let best: { t: number } | null = null;
    for (const c of list ?? []) if (Math.abs(c.t - t) <= win && (!best || Math.abs(c.t - t) < Math.abs(best.t - t))) best = c;
    return best;
  };
  const bySym = <T extends { symbol: string }>(arr: T[], time: (r: T) => number) => {
    const m = new Map<string, (T & { t: number })[]>();
    for (const r of arr) (m.get(r.symbol) ?? m.set(r.symbol, []).get(r.symbol)!).push({ ...r, t: time(r) });
    return m;
  };
  const liveRows = bySym(raw.filter(r => r.source === 'live').map(r => ({ ...r, x: fromJsonFeatures(r.features), rt: false })), r => r.entryTime.getTime());
  const decOnly: { symbol: string; t: number; x: number[]; pnl: number }[] = [];
  let liveRealtime = 0;
  for (const d of decs) {
    if (d.simNetPnlPct === null) continue;
    const t = d.decidedAt.getTime();
    const lv = near(liveRows.get(d.symbol), t) as any;
    if (lv && !lv.rt) { lv.x = fromJsonFeatures(d.features); lv.rt = true; liveRealtime++; continue; }
    decOnly.push({ symbol: d.symbol, t, x: fromJsonFeatures(d.features), pnl: d.simNetPnlPct });
  }
  const decBySym = bySym(decOnly, r => r.t);

  let liveReplaced = 0, decisionReplaced = 0;
  const samples: Sample[] = [];
  for (const list of liveRows.values()) for (const r of list) samples.push({ x: r.x, y: 0, pnl: r.netPnlPct, t: r.t, w: opts.liveWeight, live: true });
  for (const d of decOnly) samples.push({ x: d.x, y: 0, pnl: d.pnl, t: d.t, w: 1, live: false });
  for (const r of raw) {
    if (r.source !== 'backtest') continue;
    const t = r.entryTime.getTime();
    if (near(liveRows.get(r.symbol), t)) { liveReplaced++; continue; }
    if (near(decBySym.get(r.symbol), t)) { decisionReplaced++; continue; }
    samples.push({ x: fromJsonFeatures(r.features), y: 0, pnl: r.netPnlPct, t, w: 1, live: false });
  }

  if (samples.length < MIN_SAMPLES) {
    throw new Error(`학습 데이터가 ${samples.length}건뿐입니다 (최소 ${MIN_SAMPLES}건). 기간을 늘리거나 조건을 넓혀보세요.`);
  }

  // 라벨
  let lossCutPct: number | undefined;
  if (opts.target === 'avoidLoss') {
    const wins = samples.map(s => s.pnl).filter(v => v > 0).sort((a, b) => a - b);
    const medWin = wins.length ? wins[wins.length >> 1] : 0;
    lossCutPct = +Math.max(3, 2 * medWin).toFixed(2);
    for (const s of samples) s.y = s.pnl > -lossCutPct ? 1 : 0;
  } else {
    for (const s of samples) s.y = s.pnl > 0 ? 1 : 0;
  }
  const nNeg = samples.filter(s => s.y === 0).length, nPos = samples.length - nNeg;
  if (Math.min(nNeg, nPos) < 15) {
    throw new Error(opts.target === 'avoidLoss'
      ? `큰 손실(순손익 ${-lossCutPct!}% 이하) 거래가 ${nNeg}건뿐이라 학습할 수 없습니다. 학습 목표를 '수익 여부'로 바꾸거나 기간을 늘려보세요.`
      : `이긴 거래 ${nPos}건 / 진 거래 ${nNeg}건 — 한쪽이 너무 적어 학습할 수 없습니다.`);
  }

  // 시간순 분할 — 미래 데이터로 과거를 맞히는 착시(look-ahead) 방지
  samples.sort((a, b) => a.t - b.t);
  const cut = Math.floor(samples.length * 0.7);
  const tr = samples.slice(0, cut), te = samples.slice(cut);

  // 파라미터 탐색: 학습 구간 안에서만 (앞 75% 학습 / 뒤 25% 검증, 시간순) — 최종 검증 구간(te)은 건드리지 않음
  const grid: GbdtParams[] = [];
  for (const depth of [2, 3, 4]) for (const minLeaf of [20, 50]) for (const [lr, trees] of [[0.05, 150], [0.02, 350]]) {
    grid.push({ ...DEFAULT_PARAMS, depth, minLeaf, lr, trees });
  }
  const ic = Math.floor(tr.length * 0.75);
  const iTr = tr.slice(0, ic), iVa = tr.slice(ic);
  const search: NonNullable<MlFilterState['metrics']['search']> = [];
  job.total = grid.length;
  for (const p of grid) {
    job.phase = '파라미터 탐색';
    const m = await trainGbdtAsync(iTr.map(s => s.x), iTr.map(s => s.y), p, iTr.map(s => s.w));
    search.push({ depth: p.depth, minLeaf: p.minLeaf, lr: p.lr, trees: p.trees, auc: +auc(iVa.map(s => predictGbdt(m, s.x)), iVa.map(s => s.y)).toFixed(3) });
    job.done++;
  }
  const bestIdx = search.reduce((b, r, i) => (r.auc > search[b].auc + 1e-9 ? i : b), 0);   // 동률이면 단순한(앞쪽) 설정
  const params = grid[bestIdx];

  job.phase = '최종 검증·학습';
  job.done = 0; job.total = 0;
  const evalModel = await trainGbdtAsync(tr.map(s => s.x), tr.map(s => s.y), params, tr.map(s => s.w));
  const pTest = te.map(s => predictGbdt(evalModel, s.x));
  const yTest = te.map(s => s.y);
  const pnlTest = te.map(s => s.pnl);

  const baseline = { trades: te.length, stats: computePnlStats(pnlTest), sumPct: pnlTest.reduce((a, b) => a + b, 0) };
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

  // 검증 구간 중 실거래 표본만 따로 본 AUC (실제 체결 결과에서도 구분이 되는지)
  const liveIdx = te.map((s, i) => (s.live ? i : -1)).filter(i => i >= 0);
  const liveY = liveIdx.map(i => yTest[i]);
  const liveAuc = liveIdx.length >= 20 && liveY.some(v => v === 1) && liveY.some(v => v === 0)
    ? +auc(liveIdx.map(i => pTest[i]), liveY).toFixed(3) : null;

  // 최종 모델: 전체 데이터로 재학습 (가장 최근 구간까지 반영)
  const finalModel = await trainGbdtAsync(samples.map(s => s.x), samples.map(s => s.y), params, samples.map(s => s.w));
  const totalGain = finalModel.gain.reduce((a, b) => a + b, 0) || 1;
  const importance = FEATURE_NAMES
    .map((name, i) => ({ name, label: FEATURE_LABELS[name] ?? name, pct: +(finalModel.gain[i] / totalGain * 100).toFixed(1) }))
    .sort((a, b) => b.pct - a.pct);

  const liveCount = samples.filter(s => s.live).length;
  const dataFrom = samples[0].t, dataTo = samples[samples.length - 1].t;
  const missingPct: Record<string, number> = {};
  FEATURE_NAMES.forEach((name, f) => {
    const miss = samples.filter(s => Number.isNaN(s.x[f])).length;
    if (miss > 0) missingPct[name] = +(miss / samples.length * 100).toFixed(1);
  });

  return {
    version: 1,
    target: opts.target,
    applyPaper: false,
    applyLive:  false,
    threshold: recommended ?? best?.threshold ?? 0.5,
    trainedAt: Date.now(),
    trainedFor: configHash,
    days: Math.max(1, Math.round((dataTo - dataFrom) / DAY)),
    featureNames: [...FEATURE_NAMES],
    model: finalModel,
    metrics: {
      samples: samples.length, trainSamples: tr.length, testSamples: te.length,
      testFrom: te[0].t,
      auc: +testAuc.toFixed(3),
      baseline, table, recommended, importance,
      coins: data.lastCollect?.coins ?? 0, coinsFailed: data.lastCollect?.failed ?? 0,
      sources: {
        backtest: samples.length - liveCount - decOnly.length, live: liveCount, liveReplaced, liveWeight: opts.liveWeight,
        decision: decOnly.length, decisionReplaced, liveRealtime,
      },
      liveTest: { samples: liveIdx.length, auc: liveAuc },
      dataFrom, dataTo,
      lossCutPct, labelPosPct: +(nPos / samples.length * 100).toFixed(1),
      params: { depth: params.depth, minLeaf: params.minLeaf, lr: params.lr, trees: params.trees },
      search: [...search].sort((a, b) => b.auc - a.auc),
      missingPct,
    },
  };
}

// ── 자동 업데이트 스케줄러: 1시간마다 확인, 주기가 된 전략 하나씩 (새 데이터 추가 + 재학습) ──
export function startMlScheduler() {
  const tick = async () => {
    try {
      if (anyRunning()) return;
      const rows = await prisma.strategy.findMany({ select: { id: true, userId: true, mlData: true } });
      const now = Date.now();
      for (const r of rows) {
        const d = r.mlData as unknown as MlDataState | null;
        if (!d?.autoUpdate) continue;
        const last = Math.max(d.lastAuto?.at ?? 0, d.lastCollect?.at ?? 0);
        if (now - last < (d.autoEveryDays || 7) * DAY) continue;
        console.log(`[ml] 자동 업데이트 시작: ${r.id}`);
        startTraining(r.userId, r.id, {
          days: 180, reset: false, includeLive: d.includeLive ?? true, includeDecisions: d.includeDecisions ?? true, liveWeight: d.liveWeight ?? 2, target: d.target ?? 'profit', mode: 'auto',
        });
        return;   // 한 번에 하나
      }
    } catch (e) {
      console.error('[ml] 자동 업데이트 확인 실패', e);
    }
  };
  setTimeout(tick, 10 * 60_000);   // 서버 시작 직후 스캐너 복구와 겹치지 않게 10분 뒤 첫 확인
  setInterval(tick, 60 * 60_000);

  migrateLegacyModels().catch(e => console.error('[ml] 모델 이전 실패', e));
  // 이전 버전에서 보유 중에 쌓인 중복 판정 표시 (통계·학습·평가 제외)
  markHoldingDecisions()
    .then(n => { if (n > 0) console.log(`[ml] 보유 중 중복 판정 ${n}건 표시 (통계·학습 제외)`); })
    .catch(e => console.error('[ml] 중복 판정 정리 실패', e));

  // AI 판정 사후 평가: 1시간마다 결과가 확정된 판정을 시뮬레이션해 맞음/틀림 기록 (학습 중엔 건너뜀 — 요청 한도 보호)
  const evalTick = async () => {
    if (anyRunning()) return;
    try {
      const r = await evaluatePendingDecisions();
      if (r.done + r.unresolved > 0) console.log(`[ml] 판정 평가: 확정 ${r.done}건, 미확정 처리 ${r.unresolved}건, 대기 ${r.pending}건`);
    } catch (e) {
      console.error('[ml] 판정 평가 실패', e);
    }
  };
  setTimeout(evalTick, 15 * 60_000);
  setInterval(evalTick, 60 * 60_000);
}

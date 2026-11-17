import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { binance } from '../binance';
import { runBacktest, computePnlStats } from '../backtest';
import { selectTopVolume } from '../candidateFilter';
import { Kline, StrategyConditions, TradeConfig, Side, PnlStats } from '../../types';
import { computeFeatures, fundingRateAt, FEATURE_NAMES, FEATURE_LABELS } from './features';
import { trainGbdt, predictGbdt, auc, GbdtModel, DEFAULT_PARAMS } from './gbdt';

// ── AI 진입 필터 학습 ──────────────────────────────────────────
// 데이터(DB ml_samples 테이블에 누적 저장):
//   · backtest: 전략 조건으로 전체 알트코인 백테스트(순손익) → 거래마다 "진입 시점 입력값 → 순손익"
//               처음엔 N일치를 수집하고, 이후 학습/자동 업데이트 때마다 마지막 수집 시점 이후만 추가
//   · live:     내 실거래 기록(LiveTradeLog, 수수료·펀딩 반영 완료분)을 같은 입력값으로 변환해 추가
//               같은 신호의 백테스트 표본은 실거래 표본으로 대체 + 가중치를 더 줌 (실제 체결 결과가 정답)
// 학습: 시간순 앞 70%로 학습, 뒤 30%(최근)로 검증 → 기준 확률별 "걸렀을 때 성과" 표 → 전체 데이터로 최종 모델

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
  days: number;                // 학습 데이터 기간 (일)
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
    // 아래는 데이터 누적 기능 이후 추가 (옛 모델엔 없음)
    sources?: { backtest: number; live: number; liveReplaced: number; liveWeight: number };
    liveTest?: { samples: number; auc: number | null };   // 검증 구간 중 실거래 표본만의 AUC
    dataFrom?: number;
    dataTo?: number;
  };
}

// 학습 데이터 수집 상태 (Strategy.mlData)
export interface MlDataState {
  configHash: string;          // 백테스트 표본을 만든 전략 설정 — 바뀌면 백테스트 표본을 새로 수집
  collectedFrom: number;
  collectedUntil: number;      // 다음 수집 시작점 (아직 안 끝난 거래가 있으면 그 진입 시각)
  includeLive: boolean;
  liveWeight: number;
  autoUpdate: boolean;         // 주기적으로 새 데이터 추가 + 재학습
  autoEveryDays: number;
  lastCollect?: { at: number; coins: number; failed: number; added: number };
  lastAuto?: { at: number; ok: boolean; message: string };
}

export interface TrainOptions {
  days: number;                // 처음 수집(또는 reset) 시 백테스트 기간
  reset: boolean;              // 백테스트 표본을 지우고 처음부터 다시 수집
  includeLive: boolean;
  liveWeight: number;
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
export const FEATURE_VER = crypto.createHash('sha1').update(FEATURE_NAMES.join(',')).digest('hex').slice(0, 12);
const DAY = 86_400_000;
const WARMUP = 9 * DAY;          // 입력값 계산에 최대 7일(168h) 과거 + 백테스트 포지션 상태 워밍업
const MAX_CURSOR_LAG = 30 * DAY; // 안 끝난 거래 때문에 수집 시작점이 무한정 뒤에 머물지 않도록
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

// 실거래 기록의 순손익 % (증거금 대비) — 비교 화면(routes/strategy.ts)과 같은 계산
export function liveNetPct(l: { pnlPct: number; pnlUsdt: number; entryAmountUsdt: number; fundingFee: number; commission: number }): number {
  const basis = Math.abs(l.pnlPct) > 1e-9 ? l.pnlUsdt * 100 / l.pnlPct : l.entryAmountUsdt;
  return basis > 0 ? (l.pnlUsdt + l.fundingFee + l.commission) / basis * 100 : 0;
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
  if (opts.reset || !data || data.configHash !== hash) {
    await prisma.mlSample.deleteMany({ where: { strategyId, source: 'backtest' } });
    const from = runStart - opts.days * DAY;
    data = await saveData(strategyId, {
      configHash: hash, collectedFrom: from, collectedUntil: from, lastCollect: undefined,
      includeLive: opts.includeLive, liveWeight: opts.liveWeight,
    });
  } else {
    data = await saveData(strategyId, { includeLive: opts.includeLive, liveWeight: opts.liveWeight });
  }
  if (runStart - data.collectedUntil > 3_600_000) {
    const r = await collectBacktestSamples(strategyId, conditions, trade, side, hash, data.collectedUntil, runStart, job);
    // 수집 진행분은 학습 성공 여부와 무관하게 바로 저장 (다음 번엔 여기서부터)
    data = await saveData(strategyId, { collectedUntil: r.cursor, lastCollect: { at: runStart, coins: r.coins, failed: r.failed, added: r.added } });
  }

  // 2) 실거래 표본: 아직 변환 안 한 거래만
  if (opts.includeLive) await syncLiveSamples(userId, strategyId, row.name, job);

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
    await prisma.strategy.update({ where: { id: strategyId }, data: { mlFilter: state as any } });
    if (opts.mode === 'auto') {
      await saveData(strategyId, {
        lastAuto: { at: Date.now(), ok: true, message: passed ? `재학습 완료 — 기준 ${(state.threshold * 100).toFixed(1)}%` : `재학습 완료 — 추천 기준 없음 (AUC ${state.metrics.auc})` },
      });
    }
  }
  job.status = 'done';
  job.phase = '완료';
}

// ── 후보 코인: 전략 검증(validate)과 동일한 기준 ─────────────────────
async function selectCoins(conditions: StrategyConditions) {
  const [tickers, onboardDates] = await Promise.all([binance.getFutures24hrTickers(), binance.getFuturesOnboardDates()]);
  const minListingMs = conditions.minListingDays ? conditions.minListingDays * DAY : 0;
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
  return { coins, onboardDates };
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
  const processed: string[] = [];
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
        const bt = await runBacktest(kI, {
          conditions, trade, interval, side,
          btcKlines: conditions.btcChangeFilter ? alignByTime(btcI, kI) : undefined,
          fundingWait: true,
        }, sym);
        if (bt.trades.length === 0) continue;
        const funding = await binance.getFundingRateHistory(sym, bt.trades[0].entryTime, true);   // 캐시 적중
        const lastOpen = kI[kI.length - 1].openTime;
        for (const t of bt.trades) {
          if (t.entryTime < fromT) continue;
          // 데이터 끝(진행 중 캔들)에서 강제로 끊긴 거래 = 아직 안 끝난 거래 → 결과(라벨)가 확정 아님.
          // 저장하지 않고 다음 수집 때 다시 계산 (이전 버전은 이런 거래를 '시간 만료'로 학습에 넣었음)
          if (t.exitReason === 'timeout' && t.exitTime >= lastOpen) { minUnfinished = Math.min(minUnfinished, t.entryTime); continue; }
          if (t.fundingMissing) continue;
          const x = computeFeatures(k1h, btc1h, t.entryTime, fundingRateAt(funding, t.entryTime), onboardDates.get(sym));
          if (!x) continue;
          rows.push({
            strategyId, source: 'backtest', symbol: sym,
            entryTime: new Date(t.entryTime), exitTime: new Date(t.exitTime),
            features: x, featureVer: FEATURE_VER, configHash,
            netPnlPct: t.netPnlPct, grossPnlPct: t.pnlPct,
          });
        }
      } catch (e: any) {
        failed++;
        console.warn(`[ml] ${sym} 데이터 실패: ${e.message}`);
      } finally {
        job.done++;
      }
    }
  }));

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
  for (const l of logs) (bySym.get(l.symbol) ?? bySym.set(l.symbol, []).get(l.symbol)!).push(l);
  const minE = logs[0].entryTime.getTime(), maxE = logs[logs.length - 1].entryTime.getTime();

  job.phase = `실거래 기록 → 학습 데이터 변환 (${logs.length}건)`;
  job.done = 0;
  job.total = bySym.size;
  const onboard = await binance.getFuturesOnboardDates();
  const btc1h = await binance.getFuturesKlinesRange('BTCUSDT', '1h', minE - WARMUP, maxE + 3_600_000);
  const rows: any[] = [];
  const queue = [...bySym.entries()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item; (item = queue.shift()); ) {
      const [sym, list] = item;
      try {
        const s = list[0].entryTime.getTime(), e = list[list.length - 1].entryTime.getTime();
        const k1h = await binance.getFuturesKlinesRange(sym, '1h', s - WARMUP, e + 3_600_000);
        const funding = await binance.getFundingRateHistory(sym, s - 3 * DAY, true);
        for (const l of list) {
          const entry = l.entryTime.getTime();
          // 진입 순간의 1h 캔들은 지금 받으면 '완성본'이라 진입 이후 가격이 섞임 → 그 캔들 시작 시각 기준(직전 완성봉까지)으로 계산
          const T = Math.floor(entry / 3_600_000) * 3_600_000;
          const x = computeFeatures(k1h, btc1h, T, fundingRateAt(funding, entry), onboard.get(sym));
          if (!x) continue;
          rows.push({
            strategyId, source: 'live', symbol: sym,
            entryTime: l.entryTime, exitTime: l.exitTime,
            features: x, featureVer: FEATURE_VER, configHash: '',
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

  // 같은 신호를 백테스트와 실거래가 둘 다 가진 경우 → 실거래 결과만 사용 (슬리피지·실제 체결 반영)
  const ivMs = (MINS[interval] ?? 60) * 60_000;
  const win = Math.max(2 * 3_600_000, 2 * ivMs);
  const liveTimes = new Map<string, number[]>();
  for (const r of raw) if (r.source === 'live') (liveTimes.get(r.symbol) ?? liveTimes.set(r.symbol, []).get(r.symbol)!).push(r.entryTime.getTime());
  let liveReplaced = 0;
  const samples: Sample[] = [];
  for (const r of raw) {
    const t = r.entryTime.getTime();
    const live = r.source === 'live';
    if (!live && (liveTimes.get(r.symbol) ?? []).some(lt => Math.abs(lt - t) <= win)) { liveReplaced++; continue; }
    samples.push({ x: r.features as number[], y: r.netPnlPct > 0 ? 1 : 0, pnl: r.netPnlPct, t, w: live ? opts.liveWeight : 1, live });
  }

  if (samples.length < MIN_SAMPLES) {
    throw new Error(`학습 데이터가 ${samples.length}건뿐입니다 (최소 ${MIN_SAMPLES}건). 기간을 늘리거나 조건을 넓혀보세요.`);
  }

  // 시간순 분할 — 미래 데이터로 과거를 맞히는 착시(look-ahead) 방지
  samples.sort((a, b) => a.t - b.t);
  const cut = Math.floor(samples.length * 0.7);
  const tr = samples.slice(0, cut), te = samples.slice(cut);
  const evalModel = trainGbdt(tr.map(s => s.x), tr.map(s => s.y), DEFAULT_PARAMS, tr.map(s => s.w));
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
  const finalModel = trainGbdt(samples.map(s => s.x), samples.map(s => s.y), DEFAULT_PARAMS, samples.map(s => s.w));
  const totalGain = finalModel.gain.reduce((a, b) => a + b, 0) || 1;
  const importance = FEATURE_NAMES
    .map((name, i) => ({ name, label: FEATURE_LABELS[name] ?? name, pct: +(finalModel.gain[i] / totalGain * 100).toFixed(1) }))
    .sort((a, b) => b.pct - a.pct);

  const liveCount = samples.filter(s => s.live).length;
  const dataFrom = samples[0].t, dataTo = samples[samples.length - 1].t;
  return {
    version: 1,
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
      sources: { backtest: samples.length - liveCount, live: liveCount, liveReplaced, liveWeight: opts.liveWeight },
      liveTest: { samples: liveIdx.length, auc: liveAuc },
      dataFrom, dataTo,
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
        startTraining(r.userId, r.id, { days: 180, reset: false, includeLive: d.includeLive ?? true, liveWeight: d.liveWeight ?? 2, mode: 'auto' });
        return;   // 한 번에 하나
      }
    } catch (e) {
      console.error('[ml] 자동 업데이트 확인 실패', e);
    }
  };
  setTimeout(tick, 10 * 60_000);   // 서버 시작 직후 스캐너 복구와 겹치지 않게 10분 뒤 첫 확인
  setInterval(tick, 60 * 60_000);
}

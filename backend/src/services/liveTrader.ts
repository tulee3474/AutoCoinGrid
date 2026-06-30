import { BinanceService } from './binance';
import { scanMarket } from './scanner';
import { StrategyConfig, StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/crypto';
import { calcPdfStopLoss } from './gridUtils';

const SCAN_INTERVAL_MS = 60_000;
const SYNC_INTERVAL_MS = 15_000;   // TP/SL 체결 감지 전용 빠른 인터벌

// ── 타입 ──────────────────────────────────────────────────────

type LogType = 'info' | 'signal' | 'close' | 'error';
interface LogEntry { time: number; message: string; type: LogType }

interface LiveUserState {
  interval:     NodeJS.Timeout | null;   // 60s: 신호 스캔 + sync
  syncInterval: NodeJS.Timeout | null;   // 15s: TP/SL 체결 동기화 전용
  isStopping: boolean;
  isSyncing:  boolean;                   // 동시 실행 방지 플래그
  log: LogEntry[];
}

// ── per-user 라이브 트레이더 Map ──────────────────────────────

const traders = new Map<string, LiveUserState>();

function ensureState(userId: string): LiveUserState {
  if (!traders.has(userId)) traders.set(userId, { interval: null, syncInterval: null, isStopping: false, isSyncing: false, log: [] });
  return traders.get(userId)!;
}

function addLog(userId: string, message: string, type: LogType = 'info') {
  const state = traders.get(userId);
  if (!state) return;
  state.log.unshift({ time: Date.now(), message, type });
  if (state.log.length > 100) state.log.pop();
  console.log(`[LiveTrader:${userId.slice(0, 6)}] ${message}`);
}

// ── BTC 도미넌스 캐시 (전역) ──────────────────────────────────

let cachedDom = 50;
let domFetchedAt = 0;

async function getBtcDominance(): Promise<number> {
  if (Date.now() - domFetchedAt < 5 * 60_000) return cachedDom;
  try {
    const { default: axios } = await import('axios');
    const { data } = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 });
    cachedDom = data.data?.market_cap_percentage?.btc ?? 50;
    domFetchedAt = Date.now();
  } catch { /* 캐시 유지 */ }
  return cachedDom;
}

// ── 사용자 Binance 인스턴스 ───────────────────────────────────

async function getUserBinance(userId: string): Promise<BinanceService> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.apiKey || !user?.apiSecret) throw new Error('Binance API 키가 등록되지 않았습니다');
  try {
    return new BinanceService(decrypt(user.apiKey), decrypt(user.apiSecret));
  } catch {
    throw new Error('API 키 복호화 실패 — 서버 암호화 키가 변경됐을 수 있습니다. 내 정보에서 API 키를 다시 입력해주세요.');
  }
}

// ── 헤지 모드 감지 헬퍼 ──────────────────────────────────────

const hedgeModeCache = new Map<string, boolean>();

async function getHedgeMode(userId: string, svc: BinanceService): Promise<boolean> {
  if (hedgeModeCache.has(userId)) return hedgeModeCache.get(userId)!;
  try {
    const hedgeMode = await svc.getDualSidePosition();
    hedgeModeCache.set(userId, hedgeMode);
    return hedgeMode;
  } catch {
    return false; // 조회 실패 시 단방향 모드로 가정
  }
}

// positionSide('SHORT'|'LONG')와 isHedge를 받아 시장가 청산 파라미터 생성
// LONG 추가 시 posSide 인자만 바꾸면 됨
function closeOrderParams(
  symbol: string,
  posSide: 'SHORT' | 'LONG',
  quantity: string,
  isHedge: boolean
): Parameters<BinanceService['placeOrder']>[0] {
  return {
    symbol,
    side: posSide === 'SHORT' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity,
    ...(isHedge ? { positionSide: posSide } : { reduceOnly: true })
  };
}

// ── 전략 로드 (DB) ────────────────────────────────────────────

async function loadStrategies(userId: string): Promise<StrategyConfig[]> {
  const rows = await prisma.strategy.findMany({ where: { userId, enabled: true } });
  return rows.map(r => ({
    id:         r.id,
    name:       r.name,
    enabled:    r.enabled,
    coins:      r.coins as string[],
    conditions: r.conditions as unknown as StrategyConditions,
    trade:      r.trade     as unknown as TradeConfig,
    createdAt:  r.createdAt.getTime()
  }));
}

// ── 청산 기록 ─────────────────────────────────────────────────

async function recordClose(
  userId: string,
  posId: string,
  exitPrice: number,
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual',
  broadcast: (data: unknown) => void
) {
  const pos = await prisma.livePosition.findUnique({ where: { id: posId } });
  if (!pos) return null;

  const pnlPct  = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100 * pos.leverage;
  const pnlUsdt = pos.entryAmountUsdt * pnlPct / 100;

  const [log] = await prisma.$transaction([
    prisma.liveTradeLog.create({
      data: {
        userId, symbol: pos.symbol, side: pos.side,
        entryTime: pos.openedAt, exitTime: new Date(),
        entryPrice: pos.entryPrice, exitPrice,
        pnlPct, pnlUsdt, exitReason,
        entryAmountUsdt: pos.entryAmountUsdt,
        leverage: pos.leverage, strategyName: pos.strategyName
      }
    }),
    prisma.livePosition.delete({ where: { id: posId } })
  ]);

  const emoji = exitReason === 'takeProfit' ? '✅' : exitReason === 'stopLoss' ? '❌' : '⏰';
  addLog(userId,
    `${emoji} [청산] ${pos.symbol} (${exitReason}) ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | $${pnlUsdt.toFixed(2)}`,
    'close'
  );
  broadcast({ type: 'live_close', data: log });
  return log;
}

// ── TP/SL 자동 체결 동기화 ────────────────────────────────────

async function syncClosed(userId: string, broadcast: (data: unknown) => void) {
  const positions = await prisma.livePosition.findMany({ where: { userId } });
  if (positions.length === 0) return;

  const binanceSvc  = await getUserBinance(userId);
  const binancePos  = await binanceSvc.getPositions();
  const activeSymbols = new Set(binancePos.map((p: any) => p.symbol));

  for (const pos of positions) {
    if (activeSymbols.has(pos.symbol)) continue;

    // 스탠딩 주문 없는 포지션은 monitorNonOrderPositions에서 가격 모니터링으로 처리
    if (pos.tpOrderId === null) {
      await recordClose(userId, pos.id, pos.entryPrice, 'takeProfit', broadcast);
      continue;
    }

    // Binance에서 포지션이 사라짐 → TP 또는 SL 체결됨
    let exitPrice = pos.takeProfitPrice;
    let exitReason: 'takeProfit' | 'stopLoss' = 'takeProfit';

    try {
      const tpOrder = await binanceSvc.getOrder(pos.symbol, Number(pos.tpOrderId));
      if (tpOrder.status === 'FILLED') {
        exitPrice  = parseFloat(tpOrder.avgPrice) || pos.takeProfitPrice;
        exitReason = 'takeProfit';
        await binanceSvc.cancelOrder(pos.symbol, Number(pos.slOrderId)).catch(() => {});
      } else {
        const slOrder = await binanceSvc.getOrder(pos.symbol, Number(pos.slOrderId));
        if (slOrder.status === 'FILLED') {
          exitPrice  = parseFloat(slOrder.avgPrice) || pos.stopLossPrice;
          exitReason = 'stopLoss';
          await binanceSvc.cancelOrder(pos.symbol, Number(pos.tpOrderId)).catch(() => {});
        }
      }
    } catch { /* 주문 조회 실패 시 TP 가정 */ }

    await recordClose(userId, pos.id, exitPrice, exitReason, broadcast);
  }
}

// ── 타임아웃 청산 ─────────────────────────────────────────────

async function closeTimedOut(userId: string, broadcast: (data: unknown) => void) {
  const positions = await prisma.livePosition.findMany({ where: { userId } });
  const expired   = positions.filter(p => Date.now() >= p.expiresAt.getTime());
  if (expired.length === 0) return;

  const binanceSvc = await getUserBinance(userId);
  const isHedge = await getHedgeMode(userId, binanceSvc);

  for (const pos of expired) {
    try {
      await binanceSvc.cancelAllOrders(pos.symbol);
      const binancePositions = await binanceSvc.getPositions();
      const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);

      if (binPos) {
        const closeOrder = await binanceSvc.placeOrder(
          closeOrderParams(pos.symbol, pos.side as 'SHORT' | 'LONG',
            Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
        );
        const exitPrice = parseFloat(closeOrder.avgPrice) || parseFloat(binPos.markPrice);
        await recordClose(userId, pos.id, exitPrice, 'timeout', broadcast);
      } else {
        await prisma.livePosition.delete({ where: { id: pos.id } });
      }
    } catch (e: any) {
      addLog(userId, `타임아웃 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
    }
  }
}

// ── 신규 포지션 진입 ──────────────────────────────────────────

export async function openLivePosition(
  userId: string,
  symbol: string,
  entryPrice: number,
  strategyName: string,
  trade: TradeConfig,
  broadcast: (data: unknown) => void
) {
  const existing = await prisma.livePosition.findFirst({ where: { userId, symbol } });
  if (existing) return null;

  const binanceSvc = await getUserBinance(userId);

  // 잔액 사전 확인 (부족 시 주문 없이 조기 종료)
  try {
    const accountInfo      = await binanceSvc.getAccountInfo();
    const availableBalance = parseFloat(accountInfo.availableBalance ?? '0');
    if (availableBalance < trade.entryAmountUsdt) {
      addLog(userId,
        `💰 잔액 부족 ${symbol}: 가용 $${availableBalance.toFixed(2)} < 필요 $${trade.entryAmountUsdt}`,
        'error'
      );
      return null;
    }
  } catch (e: any) {
    addLog(userId, `잔액 조회 실패 ${symbol}: ${e.response?.data?.msg ?? e.message}`, 'error');
    return null;
  }

  let isHedge = false;
  const posSide = 'SHORT' as const; // LONG 추가 시 파라미터로 변경

  try {
    await binanceSvc.setMarginType(symbol, 'ISOLATED');
    await binanceSvc.setLeverage(symbol, trade.leverage);

    const info       = await binanceSvc.getFuturesExchangeInfo();
    const symbolInfo = info.symbols.find((s: any) => s.symbol === symbol);
    const qtyPrec    = symbolInfo?.quantityPrecision  ?? 2;
    const pricePrec  = symbolInfo?.pricePrecision     ?? 2;

    const qty = parseFloat((trade.entryAmountUsdt * trade.leverage / entryPrice).toFixed(qtyPrec));
    if (qty <= 0) {
      addLog(userId, `수량 계산 오류 ${symbol}: qty=${qty} (진입금 $${trade.entryAmountUsdt}, 레버리지 ${trade.leverage}x, 가격 $${entryPrice})`, 'error');
      return null;
    }

    const tpPrice = entryPrice * (1 - trade.takeProfitPct / 100);
    // gridEnabled=false이면 stopLossPct 직접 사용
    const gridEnabled = trade.gridEnabled !== false;
    const slPrice     = gridEnabled
      ? calcPdfStopLoss(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing)
      : entryPrice * (1 + trade.stopLossPct / 100);

    isHedge = await getHedgeMode(userId, binanceSvc);
    const entryOrder  = await binanceSvc.placeOrder({
      symbol, side: 'SELL', type: 'MARKET', quantity: qty.toString(),
      ...(isHedge ? { positionSide: posSide } : {})
    });
    // Binance Futures MARKET 주문의 avgPrice는 "0.00000" 반환 버그 있음 → cumQuote/executedQty 사용
    const filledQty   = parseFloat(entryOrder.executedQty || '0') || qty;
    const cumQuote    = parseFloat(entryOrder.cumQuote || '0');
    const actualEntry = (filledQty > 0 && cumQuote > 0)
      ? cumQuote / filledQty
      : (parseFloat(entryOrder.avgPrice) || entryPrice);

    let tpOrderId: bigint | null = null;
    let slOrderId: bigint | null = null;

    try {
      const tpOrder = await binanceSvc.placeOrder({
        symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET',
        quantity: filledQty.toString(), stopPrice: tpPrice.toFixed(pricePrec),
        ...(isHedge ? { positionSide: posSide } : { reduceOnly: true })
      });
      try {
        const slOrder = await binanceSvc.placeOrder({
          symbol, side: 'BUY', type: 'STOP_MARKET',
          quantity: filledQty.toString(), stopPrice: slPrice.toFixed(pricePrec),
          ...(isHedge ? { positionSide: posSide } : { reduceOnly: true })
        });
        tpOrderId = BigInt(tpOrder.orderId);
        slOrderId = BigInt(slOrder.orderId);
      } catch (slErr: any) {
        // SL 실패 → TP도 취소 후 모니터링으로 전환 (dangling 방지)
        await binanceSvc.cancelOrder(symbol, tpOrder.orderId).catch(() => {});
        addLog(userId, `${symbol} SL 등록 실패 (${slErr.response?.data?.msg ?? slErr.message}) — 스캐너 모니터링 전환`, 'error');
      }
    } catch (tpErr: any) {
      addLog(userId, `${symbol} TP/SL 등록 실패 (${tpErr.response?.data?.msg ?? tpErr.message}) — 스캐너 모니터링 전환`, 'error');
    }

    const pos = await prisma.livePosition.create({
      data: {
        userId, symbol, side: 'SHORT', qty: filledQty,
        entryPrice: actualEntry, takeProfitPrice: tpPrice, stopLossPrice: slPrice,
        tpOrderId, slOrderId,
        entryAmountUsdt: trade.entryAmountUsdt, leverage: trade.leverage,
        expiresAt: trade.maxDurationHours != null
          ? new Date(Date.now() + trade.maxDurationHours * 3_600_000)
          : new Date(Date.now() + 365 * 24 * 3_600_000),
        strategyName
      }
    });

    addLog(userId,
      `📈 [진입] ${symbol} @ $${actualEntry.toPrecision(5)} | qty ${filledQty} | TP $${tpPrice.toPrecision(4)} | SL $${slPrice.toPrecision(4)}`,
      'signal'
    );
    broadcast({ type: 'live_signal', data: { ...pos, tpOrderId: pos.tpOrderId?.toString() ?? null, slOrderId: pos.slOrderId?.toString() ?? null } });
    return pos;
  } catch (e: any) {
    const errMsg = e.response?.data?.msg ?? e.message;
    addLog(userId, `진입 실패 ${symbol}: ${errMsg}`, 'error');
    // 진입 주문 성공 후 TP/SL 등록 실패 시 긴급 청산
    try {
      await binanceSvc.cancelAllOrders(symbol);
      const binancePositions = await binanceSvc.getPositions();
      const binPos = binancePositions.find((p: any) => p.symbol === symbol);
      if (binPos) {
        await binanceSvc.placeOrder(
          closeOrderParams(symbol, posSide, Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
        );
        addLog(userId, `⚠️ 긴급 청산 완료 ${symbol}`, 'error');
      }
    } catch (e2: any) {
      addLog(userId,
        `⛔ 긴급 청산 실패 ${symbol}: ${e2.response?.data?.msg ?? e2.message} — Binance에서 수동 확인 필요`,
        'error'
      );
    }
    return null;
  }
}

// ── 수동 청산 ─────────────────────────────────────────────────

export async function closeLivePositionManual(
  userId: string,
  symbol: string,
  broadcast: (data: unknown) => void
): Promise<boolean> {
  const pos = await prisma.livePosition.findFirst({ where: { userId, symbol } });
  if (!pos) return false;

  try {
    const binanceSvc = await getUserBinance(userId);
    const isHedge = await getHedgeMode(userId, binanceSvc);
    await binanceSvc.cancelAllOrders(symbol);

    const binancePositions = await binanceSvc.getPositions();
    const binPos = binancePositions.find((p: any) => p.symbol === symbol);

    let exitPrice = pos.entryPrice;
    if (binPos) {
      const closeOrder = await binanceSvc.placeOrder(
        closeOrderParams(symbol, pos.side as 'SHORT' | 'LONG',
          Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
      );
      exitPrice = parseFloat(closeOrder.avgPrice) || parseFloat(binPos.markPrice);
    }

    await recordClose(userId, pos.id, exitPrice, 'manual', broadcast);
    return true;
  } catch (e: any) {
    addLog(userId, `수동 청산 오류 ${symbol}: ${e.message}`, 'error');
    return false;
  }
}

// ── 스탠딩 주문 없는 포지션 가격 모니터링 ────────────────────

async function monitorNonOrderPositions(userId: string, broadcast: (data: unknown) => void) {
  const positions = await prisma.livePosition.findMany({
    where: { userId, tpOrderId: null }
  });
  if (positions.length === 0) return;

  const binanceSvc      = await getUserBinance(userId);
  const isHedge         = await getHedgeMode(userId, binanceSvc);
  const binancePositions = await binanceSvc.getPositions();
  const priceMap        = new Map<string, number>(
    binancePositions.map((p: any) => [p.symbol, parseFloat(p.markPrice)])
  );

  for (const pos of positions) {
    const price = priceMap.get(pos.symbol);
    if (price === undefined) continue;

    let exitReason: 'takeProfit' | 'stopLoss' | null = null;
    let exitPrice = price;

    if (price <= pos.takeProfitPrice) {
      exitReason = 'takeProfit'; exitPrice = pos.takeProfitPrice;
    } else if (price >= pos.stopLossPrice) {
      exitReason = 'stopLoss';   exitPrice = pos.stopLossPrice;
    }

    if (!exitReason) continue;

    try {
      const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);
      if (binPos) {
        const closeOrder = await binanceSvc.placeOrder(
          closeOrderParams(pos.symbol, pos.side as 'SHORT' | 'LONG',
            Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
        );
        exitPrice = parseFloat(closeOrder.avgPrice) || exitPrice;
      }
      await recordClose(userId, pos.id, exitPrice, exitReason, broadcast);
    } catch (e: any) {
      addLog(userId, `모니터링 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
    }
  }
}

// ── TP/SL 동기화 + 타임아웃 (mutex 보호) ─────────────────────

async function runSync(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state || state.isSyncing) return;
  state.isSyncing = true;
  try {
    await syncClosed(userId, broadcast);
    await closeTimedOut(userId, broadcast);

    // 중지 예정: 포지션이 모두 닫혔으면 완전 중지
    if (state.isStopping) {
      const remaining = await prisma.livePosition.count({ where: { userId } });
      if (remaining === 0) {
        _clearUserInterval(userId);
        addLog(userId, '⏹ 모든 포지션 정리 완료 — 실거래 스캐너 중지됨', 'info');
        broadcast({ type: 'live_stopped', userId });
      } else {
        addLog(userId, `중지 예정 — 잔여 포지션 ${remaining}개 모니터링 중`);
      }
    }
  } catch (e: any) {
    addLog(userId, `동기화 오류: ${e.message}`, 'error');
  } finally {
    state.isSyncing = false;
  }
}

// ── 스캔 사이클 ───────────────────────────────────────────────

async function runLiveScanCycle(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state) return;
  const now = new Date().toLocaleTimeString('ko');

  // runSync는 isSyncing 플래그로 중복 실행 방지 — 15s sync 인터벌과 동시 실행 시 자동 skip
  await runSync(userId, broadcast);
  await monitorNonOrderPositions(userId, broadcast);

  if (state.isStopping) return;   // runSync에서 이미 처리

  // 신호 스캔 → 신규 진입
  const strategies = await loadStrategies(userId);
  if (strategies.length === 0) { addLog(userId, `[${now}] 활성 전략 없음`); return; }

  const btcDom = await getBtcDominance();
  for (const strategy of strategies) {
    try {
      const signals     = await scanMarket(strategy.conditions, btcDom);
      const fullSignals = signals.filter(s => s.signalScore >= 100);
      addLog(userId, `[${now}] 전략 "${strategy.name}": 후보 ${signals.length}개, 충족 ${fullSignals.length}개`);
      for (const signal of fullSignals) {
        await openLivePosition(userId, signal.symbol, signal.price, strategy.name, strategy.trade, broadcast);
      }
      broadcast({ type: 'live_scan', data: { signals: fullSignals, scannedAt: Date.now() } });
    } catch (e: any) {
      addLog(userId, `전략 "${strategy.name}" 스캔 오류: ${e.message}`, 'error');
    }
  }
}

function _clearUserInterval(userId: string) {
  const state = traders.get(userId);
  if (state?.interval)     { clearInterval(state.interval);     state.interval     = null; }
  if (state?.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
  state && (state.isStopping = false);
  prisma.user.update({ where: { id: userId }, data: { liveActive: false } }).catch(() => {});
}

// ── 공개 API ─────────────────────────────────────────────────

export function isLiveRunning(userId: string)  { return !!(traders.get(userId)?.interval); }
export function isLiveStopping(userId: string) { return !!(traders.get(userId)?.isStopping); }
export function getLiveLog(userId: string)     { return traders.get(userId)?.log ?? []; }

export function getRunningLiveUserIds(): string[] {
  return Array.from(traders.entries())
    .filter(([, s]) => !!s.interval)
    .map(([id]) => id);
}

export function startLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = ensureState(userId);
  if (state.interval) return;
  state.isStopping = false;
  state.isSyncing  = false;
  prisma.user.update({ where: { id: userId }, data: { liveActive: true } }).catch(() => {});
  addLog(userId, '🚀 실거래 스캐너 시작 (신호 스캔 1분 / TP·SL 감지 15초)', 'info');

  // 즉시 sync 후 신호 스캔
  runLiveScanCycle(userId, broadcast).catch(e => addLog(userId, `초기 스캔 오류: ${e.message}`, 'error'));

  // 15초마다 TP/SL 체결 + 타임아웃 감지 (main cycle과 mutex로 충돌 방지)
  state.syncInterval = setInterval(
    () => runSync(userId, broadcast).catch(e => addLog(userId, `sync 오류: ${e.message}`, 'error')),
    SYNC_INTERVAL_MS
  );

  // 60초마다 신호 스캔 + sync 시도
  state.interval = setInterval(
    () => runLiveScanCycle(userId, broadcast).catch(e => addLog(userId, `스캔 오류: ${e.message}`, 'error')),
    SCAN_INTERVAL_MS
  );
}

// ── 사용자 Binance 계좌 정보 ──────────────────────────────────

export async function getLiveAccountInfo(userId: string) {
  const binanceSvc = await getUserBinance(userId);
  const info = await binanceSvc.getAccountInfo();
  return {
    totalWalletBalance:    parseFloat(info.totalWalletBalance    ?? '0'),
    availableBalance:      parseFloat(info.availableBalance      ?? '0'),
    totalUnrealizedProfit: parseFloat(info.totalUnrealizedProfit ?? '0'),
    totalMarginBalance:    parseFloat(info.totalMarginBalance    ?? '0'),
  };
}

export async function restoreLiveScanners(broadcast: (data: unknown) => void) {
  try {
    const activeUsers = await prisma.user.findMany({ where: { liveActive: true }, select: { id: true } });
    if (activeUsers.length === 0) return;
    console.log(`[LiveTrader] 서버 재시작 후 ${activeUsers.length}개 스캐너 복원 중...`);
    for (const { id } of activeUsers) {
      startLiveScanner(id, broadcast);
      console.log(`[LiveTrader] 복원: ${id.slice(0, 6)}`);
    }
  } catch (e: any) {
    console.error(`[LiveTrader] 복원 실패: ${e.message}`);
  }
}

export function stopLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state?.interval) return;

  (async () => {
    // 스캐너 모니터링 포지션(tpOrderId=null)은 스캐너 없이 관리 불가 → 즉시 청산
    const monitoringPositions = await prisma.livePosition.findMany({
      where: { userId, tpOrderId: null }
    });
    if (monitoringPositions.length > 0) {
      addLog(userId, `⚠ 스캐너 모니터링 포지션 ${monitoringPositions.length}개 자동 청산 중...`, 'info');
      try {
        const binanceSvc       = await getUserBinance(userId);
        const isHedge          = await getHedgeMode(userId, binanceSvc);
        const binancePositions = await binanceSvc.getPositions();
        for (const pos of monitoringPositions) {
          try {
            const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);
            if (binPos) {
              const closeOrder = await binanceSvc.placeOrder(
                closeOrderParams(pos.symbol, pos.side as 'SHORT' | 'LONG',
                  Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
              );
              const exitPrice = parseFloat(closeOrder.avgPrice) || parseFloat(binPos.markPrice);
              await recordClose(userId, pos.id, exitPrice, 'manual', broadcast);
            } else {
              await prisma.livePosition.delete({ where: { id: pos.id } });
            }
          } catch (e: any) {
            addLog(userId, `모니터링 포지션 청산 실패 ${pos.symbol}: ${e.message}`, 'error');
          }
        }
      } catch (e: any) {
        addLog(userId, `모니터링 포지션 청산 중 오류: ${e.message}`, 'error');
      }
    }

    const count = await prisma.livePosition.count({ where: { userId } });
    if (count === 0) {
      _clearUserInterval(userId);
      addLog(userId, '⏹ 실거래 스캐너 중지됨', 'info');
      broadcast({ type: 'live_stopped', userId });
    } else {
      state.isStopping = true;
      addLog(userId, `⏸ 중지 예정 — 잔여 포지션 ${count}개 정리 후 자동 중지`, 'info');
      broadcast({ type: 'live_status', data: { stopping: true, openCount: count } });
    }
  })().catch(e => addLog(userId, `중지 오류: ${e.message}`, 'error'));
}

export async function forceStopLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state?.interval) return;
  addLog(userId, '🛑 즉시 중지 — 모든 포지션 시장가 청산 시작', 'info');

  const positions = await prisma.livePosition.findMany({ where: { userId } });
  if (positions.length > 0) {
    const binanceSvc = await getUserBinance(userId);
    const isHedge = await getHedgeMode(userId, binanceSvc);
    for (const pos of positions) {
      try {
        await binanceSvc.cancelAllOrders(pos.symbol);
        const binancePositions = await binanceSvc.getPositions();
        const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);
        if (binPos) {
          const closeOrder = await binanceSvc.placeOrder(
            closeOrderParams(pos.symbol, pos.side as 'SHORT' | 'LONG',
              Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge)
          );
          const exitPrice = parseFloat(closeOrder.avgPrice) || parseFloat(binPos.markPrice);
          await recordClose(userId, pos.id, exitPrice, 'manual', broadcast);
        }
      } catch (e: any) {
        addLog(userId, `즉시 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
      }
    }
  }

  _clearUserInterval(userId);
  addLog(userId, '⏹ 즉시 중지 완료', 'info');
  broadcast({ type: 'live_stopped', userId });
}

export async function getLivePositions(userId: string) {
  const positions = await prisma.livePosition.findMany({ where: { userId } });
  return positions.map(p => ({
    ...p,
    tpOrderId: p.tpOrderId?.toString() ?? null,
    slOrderId: p.slOrderId?.toString() ?? null
  }));
}

export async function getLiveTradeLogs(userId: string, limit = 50) {
  return prisma.liveTradeLog.findMany({
    where:   { userId },
    orderBy: { exitTime: 'desc' },
    take:    limit
  });
}

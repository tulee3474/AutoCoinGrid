import { BinanceService } from './binance';
import { scanMarket } from './scanner';
import { StrategyConfig, StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/crypto';

const SCAN_INTERVAL_MS = 60_000;

// ── 타입 ──────────────────────────────────────────────────────

type LogType = 'info' | 'signal' | 'close' | 'error';
interface LogEntry { time: number; message: string; type: LogType }

interface LiveUserState {
  interval: NodeJS.Timeout | null;
  isStopping: boolean;
  log: LogEntry[];
}

// ── per-user 라이브 트레이더 Map ──────────────────────────────

const traders = new Map<string, LiveUserState>();

function ensureState(userId: string): LiveUserState {
  if (!traders.has(userId)) traders.set(userId, { interval: null, isStopping: false, log: [] });
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
  return new BinanceService(decrypt(user.apiKey), decrypt(user.apiSecret));
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

  for (const pos of expired) {
    try {
      await binanceSvc.cancelAllOrders(pos.symbol);
      const binancePositions = await binanceSvc.getPositions();
      const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);

      if (binPos) {
        const closeOrder = await binanceSvc.placeOrder({
          symbol: pos.symbol, side: 'BUY', type: 'MARKET',
          quantity: Math.abs(parseFloat(binPos.positionAmt)).toString(),
          reduceOnly: true
        });
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

  try {
    await binanceSvc.setMarginType(symbol, 'ISOLATED');
    await binanceSvc.setLeverage(symbol, trade.leverage);

    const info       = await binanceSvc.getFuturesExchangeInfo();
    const symbolInfo = info.symbols.find((s: any) => s.symbol === symbol);
    const qtyPrec    = symbolInfo?.quantityPrecision  ?? 2;
    const pricePrec  = symbolInfo?.pricePrecision     ?? 2;

    const qty     = parseFloat((trade.entryAmountUsdt * trade.leverage / entryPrice).toFixed(qtyPrec));
    const tpPrice = entryPrice * (1 - trade.takeProfitPct / 100);
    const slPrice = entryPrice * (1 + trade.stopLossPct  / 100);

    const entryOrder = await binanceSvc.placeOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: qty.toString() });
    const actualEntry = parseFloat(entryOrder.avgPrice) || entryPrice;

    const tpOrder = await binanceSvc.placeOrder({
      symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET',
      quantity: qty.toString(), stopPrice: tpPrice.toFixed(pricePrec), reduceOnly: true
    });
    const slOrder = await binanceSvc.placeOrder({
      symbol, side: 'BUY', type: 'STOP_MARKET',
      quantity: qty.toString(), stopPrice: slPrice.toFixed(pricePrec), reduceOnly: true
    });

    const pos = await prisma.livePosition.create({
      data: {
        userId, symbol, side: 'SHORT', qty,
        entryPrice: actualEntry, takeProfitPrice: tpPrice, stopLossPrice: slPrice,
        tpOrderId: BigInt(tpOrder.orderId), slOrderId: BigInt(slOrder.orderId),
        entryAmountUsdt: trade.entryAmountUsdt, leverage: trade.leverage,
        expiresAt: new Date(Date.now() + trade.maxDurationHours * 3_600_000),
        strategyName
      }
    });

    addLog(userId,
      `📈 [진입] ${symbol} @ $${actualEntry.toPrecision(5)} | TP $${tpPrice.toPrecision(4)} | SL $${slPrice.toPrecision(4)}`,
      'signal'
    );
    broadcast({ type: 'live_signal', data: { ...pos, tpOrderId: pos.tpOrderId.toString(), slOrderId: pos.slOrderId.toString() } });
    return pos;
  } catch (e: any) {
    addLog(userId, `진입 실패 ${symbol}: ${e.message}`, 'error');
    // 진입은 됐으나 TP/SL 등록 실패 시 긴급 청산
    try {
      await binanceSvc.cancelAllOrders(symbol);
      const binancePositions = await binanceSvc.getPositions();
      const binPos = binancePositions.find((p: any) => p.symbol === symbol);
      if (binPos) {
        await binanceSvc.placeOrder({
          symbol, side: 'BUY', type: 'MARKET',
          quantity: Math.abs(parseFloat(binPos.positionAmt)).toString(), reduceOnly: true
        });
        addLog(userId, `⚠️ 긴급 청산 완료 ${symbol}`, 'error');
      }
    } catch { /* 긴급 청산 실패 시 로그만 */ }
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
    await binanceSvc.cancelAllOrders(symbol);

    const binancePositions = await binanceSvc.getPositions();
    const binPos = binancePositions.find((p: any) => p.symbol === symbol);

    let exitPrice = pos.entryPrice;
    if (binPos) {
      const closeOrder = await binanceSvc.placeOrder({
        symbol, side: 'BUY', type: 'MARKET',
        quantity: Math.abs(parseFloat(binPos.positionAmt)).toString(), reduceOnly: true
      });
      exitPrice = parseFloat(closeOrder.avgPrice) || parseFloat(binPos.markPrice);
    }

    await recordClose(userId, pos.id, exitPrice, 'manual', broadcast);
    return true;
  } catch (e: any) {
    addLog(userId, `수동 청산 오류 ${symbol}: ${e.message}`, 'error');
    return false;
  }
}

// ── 스캔 사이클 ───────────────────────────────────────────────

async function runLiveScanCycle(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state) return;
  const now = new Date().toLocaleTimeString('ko');

  try { await syncClosed(userId, broadcast); }
  catch (e: any) { addLog(userId, `동기화 오류: ${e.message}`, 'error'); }

  try { await closeTimedOut(userId, broadcast); }
  catch (e: any) { addLog(userId, `타임아웃 체크 오류: ${e.message}`, 'error'); }

  // 중지 예정: 포지션이 모두 닫혔으면 완전 중지
  if (state.isStopping) {
    const remaining = await prisma.livePosition.count({ where: { userId } });
    if (remaining === 0) {
      _clearUserInterval(userId);
      addLog(userId, '⏹ 모든 포지션 정리 완료 — 실거래 스캐너 중지됨', 'info');
      broadcast({ type: 'live_stopped', userId });
    } else {
      addLog(userId, `[${now}] 중지 예정 — 잔여 포지션 ${remaining}개 모니터링 중`);
    }
    return;
  }

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
  if (state?.interval) { clearInterval(state.interval); state.interval = null; }
  state && (state.isStopping = false);
}

// ── 공개 API ─────────────────────────────────────────────────

export function isLiveRunning(userId: string)  { return !!(traders.get(userId)?.interval); }
export function isLiveStopping(userId: string) { return !!(traders.get(userId)?.isStopping); }
export function getLiveLog(userId: string)     { return traders.get(userId)?.log ?? []; }

export function startLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = ensureState(userId);
  if (state.interval) return;
  state.isStopping = false;
  addLog(userId, '🚀 실거래 스캐너 시작 (1분 간격)', 'info');
  runLiveScanCycle(userId, broadcast).catch(e => addLog(userId, `초기 스캔 오류: ${e.message}`, 'error'));
  state.interval = setInterval(
    () => runLiveScanCycle(userId, broadcast).catch(e => addLog(userId, `스캔 오류: ${e.message}`, 'error')),
    SCAN_INTERVAL_MS
  );
}

export function stopLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state?.interval) return;
  // 포지션이 없으면 즉시 중지, 있으면 중지 예정
  prisma.livePosition.count({ where: { userId } }).then(count => {
    if (count === 0) {
      _clearUserInterval(userId);
      addLog(userId, '⏹ 실거래 스캐너 중지됨', 'info');
      broadcast({ type: 'live_stopped', userId });
    } else {
      state.isStopping = true;
      addLog(userId, `⏸ 중지 예정 — 잔여 포지션 ${count}개 정리 후 자동 중지`, 'info');
      broadcast({ type: 'live_status', data: { stopping: true, openCount: count } });
    }
  });
}

export async function forceStopLiveScanner(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state?.interval) return;
  addLog(userId, '🛑 즉시 중지 — 모든 포지션 시장가 청산 시작', 'info');

  const positions = await prisma.livePosition.findMany({ where: { userId } });
  if (positions.length > 0) {
    const binanceSvc = await getUserBinance(userId);
    for (const pos of positions) {
      try {
        await binanceSvc.cancelAllOrders(pos.symbol);
        const binancePositions = await binanceSvc.getPositions();
        const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);
        if (binPos) {
          const closeOrder = await binanceSvc.placeOrder({
            symbol: pos.symbol, side: 'BUY', type: 'MARKET',
            quantity: Math.abs(parseFloat(binPos.positionAmt)).toString(), reduceOnly: true
          });
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
    tpOrderId: p.tpOrderId.toString(),
    slOrderId: p.slOrderId.toString()
  }));
}

export async function getLiveTradeLogs(userId: string, limit = 50) {
  return prisma.liveTradeLog.findMany({
    where:   { userId },
    orderBy: { exitTime: 'desc' },
    take:    limit
  });
}

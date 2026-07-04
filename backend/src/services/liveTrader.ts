import { BinanceService, binance } from './binance';
import { scanMarket } from './scanner';
import { computeIndicators } from './indicator';
import { StrategyConfig, StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/crypto';
import { calcPdfStopLoss, calcPdfGridPrices } from './gridUtils';

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

// ── 그리드 실패 재시도 쿨다운 (마진 부족 등으로 실패 시 15초마다 재시도/로그 스팸 방지) ──

const GRID_RETRY_COOLDOWN_MS = 5 * 60_000;
const gridFailureCooldown = new Map<string, number>();  // `${userId}:${posId}` -> 마지막 실패 시각

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

// Binance Futures MARKET 주문의 avgPrice는 "0.00000"으로 반환되는 버그가 있어
// cumQuote/executedQty(실제 체결 누적값)를 우선 사용 — 둘 다 없을 때만 avgPrice/fallback 사용
function extractFillPrice(order: any, fallback: number): number {
  const qty      = parseFloat(order?.executedQty || '0');
  const cumQuote = parseFloat(order?.cumQuote || '0');
  if (qty > 0 && cumQuote > 0) return cumQuote / qty;
  return parseFloat(order?.avgPrice) || fallback;
}

// 알고 주문(TP/SL) 체결가 추출: algoOrder 응답의 actualPrice보다 실제 체결주문(actualOrderId)을
// 재조회한 cumQuote/executedQty 기반 값이 더 정확 — entry/일반청산과 동일한 정확도 기준 적용
async function extractAlgoExitPrice(
  binanceSvc: BinanceService,
  symbol: string,
  algoOrder: any,
  fallback: number
): Promise<number> {
  const actualOrderId = algoOrder?.actualOrderId;
  if (actualOrderId) {
    try {
      const order = await binanceSvc.getOrder(symbol, Number(actualOrderId));
      const precise = extractFillPrice(order, 0);
      if (precise > 0) return precise;
    } catch { /* 재조회 실패 시 actualPrice로 폴백 */ }
  }
  return parseFloat(algoOrder?.actualPrice) || fallback;
}

// MARKET 청산 주문은 응답 시점에 체결이 완전히 settle 안 됐을 수 있어(특히 저유동성 코인)
// 최대 5회(200ms 간격) 상태를 재조회한 뒤 실제 체결가를 계산
async function placeCloseOrderAndGetExitPrice(
  binanceSvc: BinanceService,
  symbol: string,
  posSide: 'SHORT' | 'LONG',
  quantity: string,
  isHedge: boolean,
  fallbackPrice: number
): Promise<number> {
  let order = await binanceSvc.placeOrder(closeOrderParams(symbol, posSide, quantity, isHedge));
  for (let i = 0; i < 5 && order.status !== 'FILLED'; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { order = await binanceSvc.getOrder(symbol, order.orderId); } catch { break; }
  }
  return extractFillPrice(order, fallbackPrice);
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

// ── RSI 조회 헬퍼 (1h 기준, getFuturesKlines 캐시 공유) ────────

async function fetchRsi14(symbol: string): Promise<number | null> {
  try {
    const klines = await binance.getFuturesKlines(symbol, '1h', 60);
    if (klines.length < 20) return null;
    return computeIndicators(klines, '1h').rsi14;
  } catch {
    return null;
  }
}

// 포지션의 strategyName 기준으로 gridRsiSkipThreshold 조회 — 전략이 이후 비활성화돼도
// 이미 열린 포지션의 안전장치(RSI 과열 시 그리드 포기)는 그대로 유지되도록 enabled 필터 없이 조회
async function getGridSkipThresholds(userId: string, strategyNames: string[]): Promise<Map<string, number | null>> {
  if (strategyNames.length === 0) return new Map();
  const rows = await prisma.strategy.findMany({ where: { userId, name: { in: strategyNames } } });
  return new Map(rows.map(r => [r.name, (r.trade as any)?.gridRsiSkipThreshold ?? null]));
}

// 포지션의 strategyName 기준으로 rsiExitThreshold 조회 (동일하게 enabled 필터 없이 조회)
async function getRsiExitThresholds(userId: string, strategyNames: string[]): Promise<Map<string, number | null>> {
  if (strategyNames.length === 0) return new Map();
  const rows = await prisma.strategy.findMany({ where: { userId, name: { in: strategyNames } } });
  return new Map(rows.map(r => [r.name, (r.trade as any)?.rsiExitThreshold ?? null]));
}

// ── 청산 기록 ─────────────────────────────────────────────────

async function recordClose(
  userId: string,
  posId: string,
  exitPrice: number,
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual' | 'rsiOverheat' | 'signalReversal',
  broadcast: (data: unknown) => void
) {
  const pos = await prisma.livePosition.findUnique({ where: { id: posId } });
  if (!pos) return null;

  // 그리드 추가진입이 있으면 avgEntryPrice/totalEntryUsdt 기준으로 PnL 계산 (가상거래 closePaperPosition과 동일)
  const avgEntry  = pos.avgEntryPrice  > 0 ? pos.avgEntryPrice  : pos.entryPrice;
  const totalUsdt = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;

  const pnlPct  = ((avgEntry - exitPrice) / avgEntry) * 100 * pos.leverage;
  const pnlUsdt = totalUsdt * pnlPct / 100;

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

  gridFailureCooldown.delete(`${userId}:${posId}`);

  const emoji = exitReason === 'takeProfit' ? '✅' : exitReason === 'stopLoss' ? '❌'
    : exitReason === 'rsiOverheat' ? '🔥' : exitReason === 'signalReversal' ? '🔄' : '⏰';
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
  // positionAmt < 0 인 숏 포지션만 추적 — 헤지 모드에서 롱과 혼동 방지
  const activeShortSymbols = new Set(
    (binancePos as any[]).filter(p => parseFloat(p.positionAmt) < 0).map(p => p.symbol)
  );

  for (const pos of positions) {
    if (activeShortSymbols.has(pos.symbol)) continue;

    // 스탠딩 주문 없는 포지션은 monitorNonOrderPositions에서 가격 모니터링으로 처리
    if (pos.tpOrderId === null) {
      await recordClose(userId, pos.id, pos.entryPrice, 'takeProfit', broadcast);
      continue;
    }

    // Binance에서 포지션이 사라짐 → TP 또는 SL 체결됨
    // TP/SL 각각 독립적으로 조회 — 한 주문 조회가 실패해도 나머지를 반드시 확인
    let exitPrice  = pos.takeProfitPrice;
    let exitReason: 'takeProfit' | 'stopLoss' = 'takeProfit';

    let tpOrderData: any = null;
    let slOrderData: any = null;
    try { tpOrderData = await binanceSvc.getAlgoOrder(Number(pos.tpOrderId)); } catch { /* 조회 실패 */ }
    try { slOrderData = await binanceSvc.getAlgoOrder(Number(pos.slOrderId)); } catch { /* 조회 실패 */ }

    if (tpOrderData?.algoStatus === 'TRIGGERED') {
      exitPrice  = await extractAlgoExitPrice(binanceSvc, pos.symbol, tpOrderData, pos.takeProfitPrice);
      exitReason = 'takeProfit';
      await binanceSvc.cancelAlgoOrder(Number(pos.slOrderId)).catch(() => {});
    } else if (slOrderData?.algoStatus === 'TRIGGERED') {
      exitPrice  = await extractAlgoExitPrice(binanceSvc, pos.symbol, slOrderData, pos.stopLossPrice);
      exitReason = 'stopLoss';
      await binanceSvc.cancelAlgoOrder(Number(pos.tpOrderId)).catch(() => {});
    } else {
      // 청산(Liquidation) 또는 기타 — TP/SL 알고 주문이 모두 미체결이면
      // userTrades로 실제 체결가 조회
      try {
        const trades = await binanceSvc.getUserTrades(pos.symbol, pos.openedAt.getTime());
        // 숏 청산 = BUY 방향 체결 중 가장 최신
        const buyTrades = (trades as any[]).filter(t => t.side === 'BUY');
        if (buyTrades.length > 0) {
          // 여러 부분 체결 → 수량 가중 평균가
          const totalQty = buyTrades.reduce((s: number, t: any) => s + parseFloat(t.qty), 0);
          exitPrice = buyTrades.reduce((s: number, t: any) => s + parseFloat(t.price) * parseFloat(t.qty), 0) / totalQty;
          // 숏: 청산가 > 진입가이면 손실(강제청산/SL)
          exitReason = exitPrice > pos.entryPrice ? 'stopLoss' : 'takeProfit';
        }
      } catch { /* 조회 실패 시 기본값 유지 */ }
    }

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
      await binanceSvc.cancelAllAlgoOrders(pos.symbol).catch(() => {});
      const binancePositions = await binanceSvc.getPositions();
      // 숏 포지션(positionAmt < 0)만 찾아야 헤지 모드에서 롱과 혼동하지 않음
      const binPos = (binancePositions as any[]).find(p => p.symbol === pos.symbol && parseFloat(p.positionAmt) < 0);

      if (binPos) {
        const exitPrice = await placeCloseOrderAndGetExitPrice(
          binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
          Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
          parseFloat(binPos.markPrice)
        );
        await recordClose(userId, pos.id, exitPrice, 'timeout', broadcast);
      } else {
        await prisma.livePosition.delete({ where: { id: pos.id } });
      }
    } catch (e: any) {
      addLog(userId, `타임아웃 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
    }
  }
}

// ── RSI 반전 조기청산 (익절 확정, 가상거래와 동일 로직) ─────────

async function closeOnRsiReversal(userId: string, broadcast: (data: unknown) => void) {
  const positions = await prisma.livePosition.findMany({ where: { userId } });
  if (positions.length === 0) return;

  const thresholdMap = await getRsiExitThresholds(userId, [...new Set(positions.map(p => p.strategyName))]);
  const candidates = positions.filter(p => (thresholdMap.get(p.strategyName) ?? null) !== null);
  if (candidates.length === 0) return;

  const binanceSvc       = await getUserBinance(userId);
  const isHedge          = await getHedgeMode(userId, binanceSvc);
  const binancePositions = await binanceSvc.getPositions();

  for (const pos of candidates) {
    const threshold = thresholdMap.get(pos.strategyName)!;
    const rsi14 = await fetchRsi14(pos.symbol);
    if (rsi14 === null || rsi14 >= threshold) continue;

    try {
      await binanceSvc.cancelAllOrders(pos.symbol);
      await binanceSvc.cancelAllAlgoOrders(pos.symbol).catch(() => {});
      const binPos = (binancePositions as any[]).find(p => p.symbol === pos.symbol && parseFloat(p.positionAmt) < 0);

      if (binPos) {
        const exitPrice = await placeCloseOrderAndGetExitPrice(
          binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
          Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
          parseFloat(binPos.markPrice)
        );
        await recordClose(userId, pos.id, exitPrice, 'signalReversal', broadcast);
      } else {
        await prisma.livePosition.delete({ where: { id: pos.id } });
      }
    } catch (e: any) {
      addLog(userId, `RSI 반전 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
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

  if (trade.reEntryCooldownHours) {
    const cooldownMs = trade.reEntryCooldownHours * 3_600_000;
    const lastClose = await prisma.liveTradeLog.findFirst({
      where:   { userId, symbol },
      orderBy: { exitTime: 'desc' }
    });
    if (lastClose) {
      const remainingMs = cooldownMs - (Date.now() - lastClose.exitTime.getTime());
      if (remainingMs > 0) {
        addLog(userId, `⏳ 재진입 쿨다운 ${symbol}: ${(remainingMs / 3_600_000).toFixed(1)}h 남음 (최근 청산: ${lastClose.exitReason})`);
        return null;
      }
    }
  }

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

    const tpPrice     = entryPrice * (1 - trade.takeProfitPct / 100);
    const gridEnabled = trade.gridEnabled !== false;
    const slPrice     = gridEnabled
      ? calcPdfStopLoss(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing)
      : entryPrice * (1 + trade.stopLossPct / 100);
    const gridPrices  = gridEnabled
      ? calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing)
      : [];

    isHedge = await getHedgeMode(userId, binanceSvc);
    let entryOrder  = await binanceSvc.placeOrder({
      symbol, side: 'SELL', type: 'MARKET', quantity: qty.toString(),
      ...(isHedge ? { positionSide: posSide } : {})
    });
    // MARKET 주문은 체결이 비동기로 마무리될 수 있어(특히 유동성 낮은 코인) 완전 체결 상태를 재조회
    for (let i = 0; i < 5 && entryOrder.status !== 'FILLED'; i++) {
      await new Promise(r => setTimeout(r, 200));
      try { entryOrder = await binanceSvc.getOrder(symbol, entryOrder.orderId); } catch { break; }
    }
    const filledQty   = parseFloat(entryOrder.executedQty || '0') || qty;
    const actualEntry = extractFillPrice(entryOrder, entryPrice);

    let tpOrderId: bigint | null = null;
    let slOrderId: bigint | null = null;

    try {
      // 2025-12-09 Binance 정책 변경: STOP_MARKET/TAKE_PROFIT_MARKET은 /fapi/v1/order에서 막히고
      // 전용 Algo Order API(/fapi/v1/algoOrder)로 등록해야 함 (-4120 STOP_ORDER_SWITCH_ALGO)
      const tpOrder = await binanceSvc.placeAlgoOrder({
        symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET',
        triggerPrice: tpPrice.toFixed(pricePrec), closePosition: true,
        ...(isHedge ? { positionSide: posSide } : {})
      });
      try {
        const slOrder = await binanceSvc.placeAlgoOrder({
          symbol, side: 'BUY', type: 'STOP_MARKET',
          triggerPrice: slPrice.toFixed(pricePrec), closePosition: true,
          ...(isHedge ? { positionSide: posSide } : {})
        });
        tpOrderId = BigInt(tpOrder.algoId);
        slOrderId = BigInt(slOrder.algoId);
      } catch (slErr: any) {
        // SL 실패 → TP도 취소 후 모니터링으로 전환 (dangling 방지)
        await binanceSvc.cancelAlgoOrder(tpOrder.algoId).catch(() => {});
        addLog(userId, `${symbol} SL 등록 실패 (${slErr.response?.data?.msg ?? slErr.message}) — 스캐너 모니터링 전환`, 'error');
      }
    } catch (tpErr: any) {
      addLog(userId, `${symbol} TP/SL 등록 실패 (${tpErr.response?.data?.msg ?? tpErr.message}) — 스캐너 모니터링 전환`, 'error');
    }

    const pos = await prisma.livePosition.create({
      data: {
        userId, symbol, side: 'SHORT', qty: filledQty,
        entryPrice: actualEntry, avgEntryPrice: actualEntry,
        totalEntryUsdt: trade.entryAmountUsdt,
        gridPrices:  gridPrices as any,
        gridsFilled: 0,
        takeProfitPrice: tpPrice, stopLossPrice: slPrice,
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
      await binanceSvc.cancelAllAlgoOrders(symbol).catch(() => {});
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
    await binanceSvc.cancelAllAlgoOrders(symbol).catch(() => {});

    const binancePositions = await binanceSvc.getPositions();
    const binPos = binancePositions.find((p: any) => p.symbol === symbol);

    let exitPrice = pos.entryPrice;
    if (binPos) {
      exitPrice = await placeCloseOrderAndGetExitPrice(
        binanceSvc, symbol, pos.side as 'SHORT' | 'LONG',
        Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
        parseFloat(binPos.markPrice)
      );
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
        exitPrice = await placeCloseOrderAndGetExitPrice(
          binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
          Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
          exitPrice
        );
      }
      await recordClose(userId, pos.id, exitPrice, exitReason, broadcast);
    } catch (e: any) {
      addLog(userId, `모니터링 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
    }
  }
}

// ── 그리드 추가진입 (라이브) ──────────────────────────────────

async function fillLiveGrids(userId: string, broadcast: (data: unknown) => void) {
  const positions = await prisma.livePosition.findMany({ where: { userId } });
  const gridPositions = positions.filter(pos => {
    const gp = Array.isArray(pos.gridPrices) ? pos.gridPrices as number[] : [];
    return gp.length > 0 && pos.gridsFilled < gp.length;
  });
  if (gridPositions.length === 0) return;

  const binanceSvc = await getUserBinance(userId);
  const [binancePos, isHedge, exchInfo, accountInfo] = await Promise.all([
    binanceSvc.getPositions(),
    getHedgeMode(userId, binanceSvc),
    binanceSvc.getFuturesExchangeInfo(),
    binanceSvc.getAccountInfo()
  ]);
  const priceMap = new Map<string, number>(
    (binancePos as any[]).map(p => [p.symbol, parseFloat(p.markPrice)])
  );
  // 같은 사이클 내 여러 포지션/그리드가 순차로 마진을 소비하므로 실제 체결마다 차감해가며 추적
  let availableBalance = parseFloat(accountInfo.availableBalance ?? '0');
  const gridSkipMap = await getGridSkipThresholds(userId, [...new Set(gridPositions.map(p => p.strategyName))]);

  for (const pos of gridPositions) {
    const price = priceMap.get(pos.symbol);
    if (!price) continue;

    const gridKey  = `${userId}:${pos.id}`;
    const lastFail = gridFailureCooldown.get(gridKey);
    if (lastFail && Date.now() - lastFail < GRID_RETRY_COOLDOWN_MS) continue;

    const gridPrices        = pos.gridPrices as number[];
    const currentGridsFilled = pos.gridsFilled;

    // 순차적으로 도달한 그리드 수 계산
    let gridsToFill = 0;
    for (let gi = currentGridsFilled; gi < gridPrices.length; gi++) {
      if (price >= gridPrices[gi]) gridsToFill++;
      else break;
    }
    if (gridsToFill === 0) continue;

    // 1100%/500%급 급등처럼 그리드를 계속 태우면 크게 잃는 상황 방지 —
    // 이번 그리드 체결 시점 RSI가 임계값 이상이면 추가진입 포기하고 즉시 전체 청산 (가상거래와 동일 로직)
    const gridSkipThreshold = gridSkipMap.get(pos.strategyName) ?? null;
    if (gridSkipThreshold !== null) {
      const rsi14 = await fetchRsi14(pos.symbol);
      if (rsi14 !== null && rsi14 >= gridSkipThreshold) {
        addLog(userId, `🔥 RSI 과열(${rsi14.toFixed(1)}) 감지 ${pos.symbol} — 그리드 포기 + 즉시 전체청산`, 'info');
        try {
          await binanceSvc.cancelAllOrders(pos.symbol);
          await binanceSvc.cancelAllAlgoOrders(pos.symbol).catch(() => {});
          const binPosMatch = (binancePos as any[]).find((p: any) => p.symbol === pos.symbol);
          let exitPriceFinal = price;
          if (binPosMatch) {
            exitPriceFinal = await placeCloseOrderAndGetExitPrice(
              binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
              Math.abs(parseFloat(binPosMatch.positionAmt)).toString(), isHedge, price
            );
          }
          await recordClose(userId, pos.id, exitPriceFinal, 'rsiOverheat', broadcast);
        } catch (e: any) {
          addLog(userId, `RSI 과열 청산 오류 ${pos.symbol}: ${e.message}`, 'error');
        }
        continue;
      }
    }

    const symbolInfo = (exchInfo.symbols as any[]).find((s: any) => s.symbol === pos.symbol);
    const qtyPrec    = symbolInfo?.quantityPrecision ?? 2;

    let newAvgEntry  = pos.avgEntryPrice  > 0 ? pos.avgEntryPrice  : pos.entryPrice;
    let newTotalUsdt = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;
    let actualFilled = 0;

    for (let i = 0; i < gridsToFill; i++) {
      const gp      = gridPrices[currentGridsFilled + i];
      const gridQty = parseFloat((pos.entryAmountUsdt * pos.leverage / gp).toFixed(qtyPrec));

      // 마진 부족이 뻔한 주문을 매 15초 Binance에 반복 제출하지 않도록 사전 체크
      if (availableBalance < pos.entryAmountUsdt) {
        addLog(userId,
          `💰 마진 부족으로 그리드 보류 ${pos.symbol} ${currentGridsFilled + i + 1}차: 가용 $${availableBalance.toFixed(2)} < 필요 $${pos.entryAmountUsdt} — ${GRID_RETRY_COOLDOWN_MS / 60_000}분 후 재시도`,
          'error'
        );
        gridFailureCooldown.set(gridKey, Date.now());
        break;
      }

      try {
        let order = await binanceSvc.placeOrder({
          symbol: pos.symbol, side: 'SELL', type: 'MARKET',
          quantity: gridQty.toString(),
          ...(isHedge ? { positionSide: 'SHORT' } : {})
        });
        // MARKET 주문은 목표가(gp)와 실제 체결가가 다를 수 있어(특히 급등 구간) 실제 체결가로 평균단가 계산
        for (let r = 0; r < 5 && order.status !== 'FILLED'; r++) {
          await new Promise(res => setTimeout(res, 200));
          try { order = await binanceSvc.getOrder(pos.symbol, order.orderId); } catch { break; }
        }
        const actualGridPrice = extractFillPrice(order, gp);
        newAvgEntry  = (newAvgEntry * newTotalUsdt + actualGridPrice * pos.entryAmountUsdt) / (newTotalUsdt + pos.entryAmountUsdt);
        newTotalUsdt += pos.entryAmountUsdt;
        actualFilled++;
        availableBalance -= pos.entryAmountUsdt;
      } catch (e: any) {
        addLog(userId, `그리드 주문 실패 ${pos.symbol} ${currentGridsFilled + i + 1}차: ${e.response?.data?.msg ?? e.message}`, 'error');
        gridFailureCooldown.set(gridKey, Date.now());
        break;
      }
    }

    if (actualFilled === 0) continue;

    const newGridsFilled = currentGridsFilled + actualFilled;
    await prisma.livePosition.update({
      where: { id: pos.id },
      data:  { gridsFilled: newGridsFilled, avgEntryPrice: newAvgEntry, totalEntryUsdt: newTotalUsdt }
    });
    addLog(userId,
      `📈 [그리드] ${pos.symbol} ${newGridsFilled}차 추가진입 | 평균진입가: $${newAvgEntry.toPrecision(5)}`,
      'signal'
    );
    broadcast({ type: 'live_grid_fill', data: { symbol: pos.symbol, gridsFilled: newGridsFilled, avgEntryPrice: newAvgEntry } });
  }
}

// ── TP/SL 동기화 + 타임아웃 (mutex 보호) ─────────────────────

async function runSync(userId: string, broadcast: (data: unknown) => void) {
  const state = traders.get(userId);
  if (!state || state.isSyncing) return;
  state.isSyncing = true;
  try {
    await syncClosed(userId, broadcast);
    await fillLiveGrids(userId, broadcast);
    await closeOnRsiReversal(userId, broadcast);
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
              const exitPrice = await placeCloseOrderAndGetExitPrice(
                binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
                Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
                parseFloat(binPos.markPrice)
              );
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
        await binanceSvc.cancelAllAlgoOrders(pos.symbol).catch(() => {});
        const binancePositions = await binanceSvc.getPositions();
        const binPos = binancePositions.find((p: any) => p.symbol === pos.symbol);
        if (binPos) {
          const exitPrice = await placeCloseOrderAndGetExitPrice(
            binanceSvc, pos.symbol, pos.side as 'SHORT' | 'LONG',
            Math.abs(parseFloat(binPos.positionAmt)).toString(), isHedge,
            parseFloat(binPos.markPrice)
          );
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

export async function getLivePositionsEnriched(userId: string) {
  const positions = await getLivePositions(userId);
  if (positions.length === 0) return [];

  // 우선순위: Binance positionRisk 실데이터 (펀딩 피 반영된 ROE% 정확히 일치)
  try {
    const binanceSvc    = await getUserBinance(userId);
    const allBinancePos = await binanceSvc.getPositions();
    // 숏 포지션만 매칭 (positionAmt < 0)
    const shortPosMap = new Map<string, any>(
      allBinancePos
        .filter((bp: any) => parseFloat(bp.positionAmt) < 0)
        .map((bp: any) => [bp.symbol, bp])
    );
    return positions.map(pos => {
      const bp = shortPosMap.get(pos.symbol);
      if (!bp) return { ...pos, currentPrice: pos.entryPrice, pnlPct: 0, pnlUsdt: 0 };
      const currentPrice   = parseFloat(bp.markPrice);
      const pnlUsdt        = parseFloat(bp.unRealizedProfit);
      const isolatedWallet = parseFloat(bp.isolatedWallet);
      // Binance ROE% = unrealizedProfit / isolatedWallet (펀딩 피 포함)
      const pnlPct = isolatedWallet > 0 ? (pnlUsdt / isolatedWallet) * 100 : 0;
      return { ...pos, currentPrice, pnlPct, pnlUsdt };
    });
  } catch {
    // 폴백: markPrice 기반 계산 (펀딩 피 미반영)
    try {
      const indices  = await binance.getFuturesPremiumIndex() as any[];
      const priceMap = new Map<string, number>(indices.map((m: any) => [m.symbol, parseFloat(m.markPrice)]));
      return positions.map(pos => {
        const currentPrice = priceMap.get(pos.symbol) ?? pos.entryPrice;
        const pnlPct  = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
        const pnlUsdt = pos.entryAmountUsdt * pnlPct / 100;
        return { ...pos, currentPrice, pnlPct, pnlUsdt };
      });
    } catch {
      return positions.map(pos => ({ ...pos, currentPrice: pos.entryPrice, pnlPct: 0, pnlUsdt: 0 }));
    }
  }
}

export async function getLiveTradeLogs(userId: string, limit = 50) {
  return prisma.liveTradeLog.findMany({
    where:   { userId },
    orderBy: { exitTime: 'desc' },
    take:    limit
  });
}

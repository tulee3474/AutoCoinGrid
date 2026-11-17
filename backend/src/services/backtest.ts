import { Kline, StrategyConditions, TradeConfig, BacktestResult, BacktestTrade, Side, PnlStats } from '../types';
import { calcRSI, calc24hChange, candlesPerDay } from './indicator';
import { calcPdfGridPrices, calcPdfAvgEntry, calcPdfStopLoss, calcTakeProfitPrice, calcSimpleStopLoss, calcIsolatedLiquidationPrice, capSlWithLiquidation, truncateGridsToSafeZone, resolveReEntryCooldownHours, dirSign } from './gridUtils';
import { binance, binanceMaster, pickLeverageBracket, LeverageBracket, FundingRateRow } from './binance';

// 실거래는 진입·그리드 추가·TP/SL 전부 시장가(MARKET/STOP_MARKET/TAKE_PROFIT_MARKET)라 테이커 수수료 적용
// (바이낸스 USDT-M 기본 테이커 0.05%, BNB 할인/VIP 미반영)
const TAKER_FEE_RATE = 0.0005;

// 시뮬레이션 내부용 — 펀딩피 계산에 필요한 체결 이력 (펀딩 시점의 보유 수량을 구하기 위함)
interface SimFill { time: number; qty: number }
type SimTrade = Omit<BacktestTrade, 'commissionUsdt' | 'fundingUsdt' | 'fundingMissing' | 'netPnlUsdt' | 'netPnlPct'>;

export function computePnlStats(pcts: number[]): PnlStats {
  const wins   = pcts.filter(p => p > 0);
  const losses = pcts.filter(p => p <= 0);
  const winRate      = pcts.length   > 0 ? wins.length / pcts.length : 0;
  const avgProfitPct = wins.length   > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossPct   = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  return { winRate, avgProfitPct, avgLossPct, expectedValuePct: winRate * avgProfitPct - (1 - winRate) * avgLossPct };
}

interface BacktestOptions {
  conditions: StrategyConditions;
  trade: TradeConfig;
  interval: string;
  side?: Side;
  // BTC 변동률 필터용 — 대상 코인 klines와 동일한 개수/끝 시점으로 정렬된 BTCUSDT 캔들
  // (호출부에서 정렬해서 넘겨줌 — 대상 코인이 BTC보다 상장이 늦어 캔들 수가 적을 수 있음)
  btcKlines?: Kline[];
  // true면 펀딩비 조회 한도에 걸려도 생략하지 않고 기다림 (AI 필터 학습 데이터용 — 순손익 라벨이 정확해야 함)
  fundingWait?: boolean;
}

// kline 간격(분) 맵
const MINS_PER_CANDLE: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
};

// 가격 변화 기준 시간 → kline 캔들 수 변환
function candlesForPeriod(period: '1h' | '4h' | '24h', interval: string): number {
  const targetMins: Record<string, number> = { '1h': 60, '4h': 240, '24h': 1440 };
  return Math.max(1, Math.round(targetMins[period] / (MINS_PER_CANDLE[interval] ?? 60)));
}

// ── 조건 충족 여부 체크 ──────────────────────────────────────

function checkConditions(
  klines: Kline[],
  idx: number,
  conditions: StrategyConditions,
  interval: string,
  side: Side,
  btcKlines?: Kline[]
): boolean {
  const closes  = klines.slice(0, idx + 1).map(k => k.close);
  const cpd = candlesPerDay(interval);

  if (closes.length < 20) return false;

  const rsi = calcRSI(closes, conditions.rsi.period ?? 14);

  // 가격 변화: 지정된 타임프레임 기준
  const priceChangeTf = conditions.priceChangeTimeframe ?? '24h';
  const changePeriod  = priceChangeTf === '24h'
    ? cpd
    : candlesForPeriod(priceChangeTf, interval);
  const priceChange = calc24hChange(closes, changePeriod);

  // BTC 도미넌스 조건 비활성화 (나중에 추가할 수 있음)
  // const historicalDom = getDominanceAt(klines[idx].openTime);
  // const btcDomPass = historicalDom === null || historicalDom <= conditions.btcDominanceMax;

  // BTC 자체 변동률 게이트 (live/paper의 scanMarket과 동일 로직) — btcKlines가 klines와 동일하게
  // 정렬돼 있다고 가정하고 같은 idx를 사용
  let btcChangePass = true;
  if (conditions.btcChangeFilter && btcKlines && btcKlines.length > idx) {
    const btcCloses = btcKlines.slice(0, idx + 1).map(k => k.close);
    const btcPeriod = conditions.btcChangeFilter.timeframe === '24h'
      ? cpd
      : candlesForPeriod(conditions.btcChangeFilter.timeframe, interval);
    const btcChange = calc24hChange(btcCloses, btcPeriod);
    btcChangePass = btcChange >= conditions.btcChangeFilter.min && btcChange <= conditions.btcChangeFilter.max;
  }

  const rsiPass = side === 'SHORT'
    ? rsi >= conditions.rsi.min
    : rsi <= (conditions.rsi.max ?? 100);

  return (
    rsiPass &&
    priceChange >= conditions.priceChange24h.min &&
    priceChange <= conditions.priceChange24h.max &&
    btcChangePass
    // && btcDomPass
  );
}

// ── 단일 트레이드 시뮬레이션 ──────────────────────────────────

function simulateTrade(
  klines: Kline[],
  entryIdx: number,
  trade: TradeConfig,
  interval: string,
  brackets: LeverageBracket[],
  side: Side
): { trade: SimTrade; fills: SimFill[] } | null {
  if (entryIdx + 1 >= klines.length) return null;

  const entryPrice = klines[entryIdx + 1].open;
  // 펀딩피 계산용 체결 이력 — 진입·그리드 1건당 증거금(entryAmountUsdt) × 레버리지 만큼의 명목가치
  const fillNotional = trade.entryAmountUsdt * trade.leverage;
  const fills: SimFill[] = [{ time: klines[entryIdx + 1].openTime, qty: fillNotional / entryPrice }];

  // maxDurationHours: null = 캔들 끝까지, 숫자 = 시간 → 캔들 수 변환
  const maxCandles = trade.maxDurationHours != null
    ? Math.max(1, Math.round(trade.maxDurationHours * 60 / (MINS_PER_CANDLE[interval] ?? 60)))
    : klines.length;
  const maxEndIdx = Math.min(entryIdx + 1 + maxCandles, klines.length - 1);

  const gridEnabled = trade.gridEnabled !== false;
  const safetyPct = trade.liquidationSafetyPct ?? 99;

  // 유지증거금률 구간표(심볼당 1회 조회해 넘겨받음)로 청산가를 추정해, 안전마진 밖의
  // 그리드 레벨은 실거래/가상거래와 동일하게 애초에 채워질 기회가 없는 것으로 취급
  const estimateLiq = (marginUsdt: number, qty: number, avgEntry: number): number => {
    if (brackets.length === 0) return 0;
    const { mmr, cum } = pickLeverageBracket(brackets, qty * avgEntry);
    return calcIsolatedLiquidationPrice(marginUsdt, qty, avgEntry, mmr, cum, side);
  };

  let gridPrices = gridEnabled ? calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing, side) : [];
  let avgEntryPrice   = entryPrice;
  let takeProfitPrice = calcTakeProfitPrice(entryPrice, trade.takeProfitPct, side);
  let stopLossPrice: number;
  if (gridEnabled) {
    const qty = trade.entryAmountUsdt * trade.leverage / entryPrice;
    const liqPrice = estimateLiq(trade.entryAmountUsdt, qty, entryPrice);
    gridPrices = truncateGridsToSafeZone(gridPrices, entryPrice, liqPrice, safetyPct, side);
    stopLossPrice = calcPdfStopLoss(entryPrice, trade.leverage, gridPrices.length, trade.gridSpacing, side);
    stopLossPrice = capSlWithLiquidation(stopLossPrice, entryPrice, liqPrice, safetyPct, side);
  } else {
    stopLossPrice = calcSimpleStopLoss(entryPrice, trade.stopLossPct, side);
  }

  let exitPrice = 0;
  let exitTime  = 0;
  let exitReason: BacktestTrade['exitReason'] = 'timeout';
  let gridsFilled = 0;

  for (let j = entryIdx + 2; j <= maxEndIdx; j++) {
    const candle = klines[j];
    // 숏: 그리드가 진입가 위쪽에 있어 캔들 HIGH가 기준 / 롱: 그리드가 아래쪽이라 LOW가 기준
    const filledNow = side === 'SHORT'
      ? gridPrices.filter(p => candle.high >= p).length
      : gridPrices.filter(p => candle.low <= p).length;

    // 그리드 체결로 평균단가가 바뀐 만큼 TP/SL도 재계산 (실거래/가상거래와 동일 로직) —
    // 안 하면 SL이 최초 진입가 기준 캡에 고정돼 남은 그리드가 그 캡보다 먼 가격에 있으면
    // 절대 채워질 수 없는 문제가 생겨 실제 동작과 백테스트 결과가 어긋남
    if (filledNow > gridsFilled) {
      // 그리드는 캔들 도중 체결 — 체결 시각을 캔들 시작으로 두고, 같은 시각의 펀딩은 체결 전으로 취급
      for (let k = gridsFilled; k < filledNow; k++) fills.push({ time: candle.openTime, qty: fillNotional / gridPrices[k] });
      gridsFilled     = filledNow;
      avgEntryPrice   = calcPdfAvgEntry(entryPrice, gridPrices.slice(0, gridsFilled));
      const remainingLevels = gridPrices.length - gridsFilled;
      takeProfitPrice = calcTakeProfitPrice(avgEntryPrice, trade.takeProfitPct, side);
      stopLossPrice   = calcPdfStopLoss(avgEntryPrice, trade.leverage, remainingLevels, trade.gridSpacing, side, gridsFilled + 1);

      const newTotalUsdt = trade.entryAmountUsdt * (1 + gridsFilled);
      const newQty = newTotalUsdt * trade.leverage / avgEntryPrice;
      const liqPrice = estimateLiq(newTotalUsdt, newQty, avgEntryPrice);
      stopLossPrice = capSlWithLiquidation(stopLossPrice, avgEntryPrice, liqPrice, safetyPct, side);
    }

    // 숏: SL은 위쪽(HIGH로 도달)/TP는 아래쪽(LOW로 도달) / 롱: 반대
    const hitSl = side === 'SHORT' ? candle.high >= stopLossPrice   : candle.low  <= stopLossPrice;
    const hitTp = side === 'SHORT' ? candle.low  <= takeProfitPrice : candle.high >= takeProfitPrice;

    if (hitSl) {
      exitPrice  = stopLossPrice;
      exitTime   = candle.openTime;
      exitReason = 'stopLoss';
      break;
    }
    if (hitTp) {
      exitPrice  = takeProfitPrice;
      exitTime   = candle.closeTime;
      exitReason = 'takeProfit';
      break;
    }
    if (j === maxEndIdx) {
      exitPrice  = candle.close;
      exitTime   = candle.closeTime;
      exitReason = 'timeout';
    }
  }

  if (exitPrice === 0) return null;

  const pnlPct  = ((avgEntryPrice - exitPrice) / avgEntryPrice) * 100 * trade.leverage * dirSign(side);
  const pnlUsdt = (trade.entryAmountUsdt * (1 + gridsFilled)) * (pnlPct / 100);

  return {
    trade: {
      entryTime: klines[entryIdx + 1].openTime,
      exitTime,
      entryPrice,
      exitPrice,
      avgEntryPrice,
      pnlPct,
      pnlUsdt,
      exitReason,
      gridsFilled
    },
    fills
  };
}

// ── 순손익 (수수료 + 펀딩피) ───────────────────────────────────

function applyCosts(
  t: SimTrade,
  fills: SimFill[],
  trade: TradeConfig,
  side: Side,
  fundingRows: FundingRateRow[] | null,
  priceAt: (time: number) => number
): BacktestTrade {
  const totalQty    = fills.reduce((a, f) => a + f.qty, 0);
  const entryNotional = trade.entryAmountUsdt * trade.leverage * fills.length;
  const commissionUsdt = -TAKER_FEE_RATE * (entryNotional + totalQty * t.exitPrice);

  // 펀딩: 진입 시각 이후 ~ 청산 시각까지의 정산분. 시점별 보유 수량 × 마크가격 × 펀딩비,
  // 숏은 펀딩비가 양수면 받고 음수면 냄 (롱은 반대) → income = rate × 명목가치 × dirSign
  // (손절은 exitTime이 캔들 시작이라 그 시각 정산분까지 포함되도록 <=)
  let fundingUsdt = 0;
  const fundingMissing = fundingRows === null;
  if (fundingRows) {
    for (const r of fundingRows) {
      if (r.fundingTime <= t.entryTime) continue;
      if (r.fundingTime > t.exitTime) break;
      const qty = fills.reduce((a, f) => a + (f.time < r.fundingTime ? f.qty : 0), 0);
      const price = r.markPrice ?? priceAt(r.fundingTime);
      fundingUsdt += r.fundingRate * qty * price * dirSign(side);
    }
  }

  const margin     = trade.entryAmountUsdt * fills.length;
  const netPnlUsdt = t.pnlUsdt + commissionUsdt + fundingUsdt;
  return { ...t, commissionUsdt, fundingUsdt, fundingMissing, netPnlUsdt, netPnlPct: netPnlUsdt / margin * 100 };
}

// ── 특정 시각·가격에 진입했다고 가정한 단일 거래 시뮬레이션 (AI 판정 사후 평가용) ──────
// 판정 시각이 속한 캔들을 "진입 캔들"로 보고 시가를 판정 가격으로 바꾼 뒤, 백테스트와 같은 규칙
// (다음 캔들부터 그리드/TP/SL/시간 만료 확인, 수수료·펀딩 반영)으로 결과를 계산
export async function simulateEntryAt(
  klines: Kline[], entryTime: number, entryPrice: number, trade: TradeConfig, interval: string, side: Side,
  symbol: string, fundingRows: FundingRateRow[] | null
): Promise<BacktestTrade | null> {
  const candleMs = (MINS_PER_CANDLE[interval] ?? 60) * 60_000;
  const idx = klines.findIndex(k => k.openTime <= entryTime && entryTime < k.openTime + candleMs);
  if (idx < 1) return null;
  const ks = klines.slice();
  ks[idx] = { ...ks[idx], open: entryPrice };
  const brackets = trade.gridEnabled !== false
    ? await binanceMaster.getLeverageBracket(symbol).catch(() => [])
    : [];
  const sim = simulateTrade(ks, idx - 1, trade, interval, brackets, side);
  if (!sim) return null;
  const priceAt = (time: number) => {
    const i = Math.min(ks.length - 1, Math.max(0, Math.floor((time - ks[0].openTime) / candleMs)));
    return ks[i].open;
  };
  return applyCosts(sim.trade, sim.fills, trade, side, fundingRows, priceAt);
}

// ── 메인 백테스트 함수 ──────────────────────────────────────

export async function runBacktest(
  klines: Kline[],
  options: BacktestOptions,
  symbol: string
): Promise<BacktestResult> {
  const { conditions, trade, interval, side = 'SHORT', btcKlines, fundingWait = false } = options;
  const simTrades: { trade: SimTrade; fills: SimFill[] }[] = [];

  // 유지증거금률 구간표는 심볼당 하나(포지션 규모별 상수)라 캔들 루프 전에 한 번만 조회 —
  // 마스터 키 미설정/조회 실패 시 빈 배열 → 안전마진 로직은 자동으로 no-op(기존 동작 유지)
  const brackets = trade.gridEnabled !== false
    ? await binanceMaster.getLeverageBracket(symbol).catch(() => [])
    : [];

  let i = 20; // MA20 기준으로 워밍업
  while (i < klines.length - 1) {
    if (checkConditions(klines, i, conditions, interval, side, btcKlines)) {
      const sim = simulateTrade(klines, i, trade, interval, brackets, side);
      if (sim) {
        const tradeSim = sim.trade;
        simTrades.push(sim);
        console.log(
          `[BT] ${symbol} | 진입: ${tradeSim.entryPrice.toFixed(6)}` +
          ` | 평균진입: ${tradeSim.avgEntryPrice.toFixed(6)}` +
          ` | 청산: ${tradeSim.exitPrice.toFixed(6)}` +
          ` | 그리드체결: ${tradeSim.gridsFilled}개` +
          ` | 수익률: ${tradeSim.pnlPct.toFixed(2)}%` +
          ` | 사유: ${tradeSim.exitReason}` +
          ` | 진입시각: ${new Date(tradeSim.entryTime).toLocaleString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`
        );
        const wasWin = tradeSim.pnlPct > 0;
        // blockLossSymbols: 손실이면 이 심볼은 이후로 다시 진입하지 않는 실거래/가상거래 동작을
        // 백테스트에서도 동일하게 반영 — 루프를 여기서 완전히 종료
        if (trade.blockLossSymbols && !wasWin) break;

        const exitKlineIdx = klines.findIndex(k => k.openTime >= tradeSim.exitTime);
        // exitKlineIdx가 -1이면 거래가 데이터 끝까지 갔다는 뜻 → 루프 종료
        let nextIdx = exitKlineIdx > 0 ? exitKlineIdx : klines.length;
        // 이전 청산이 수익/손실이었는지에 따라 재진입 쿨다운 캔들 수만큼 스캔 스킵 (실거래/가상거래와 동일 로직)
        const cooldownHours = resolveReEntryCooldownHours(trade, wasWin);
        if (cooldownHours) {
          nextIdx += Math.round(cooldownHours * 60 / (MINS_PER_CANDLE[interval] ?? 60));
        }
        i = nextIdx;
        continue;
      }
    }
    i++;
  }

  // 펀딩비는 신호가 실제로 나온 코인만 조회 (전체 알트 검증에서도 호출 수가 신호 코인 수로 제한됨)
  const fundingRows = simTrades.length > 0
    ? await binance.getFundingRateHistory(symbol, simTrades[0].trade.entryTime, fundingWait)
    : null;
  const candleMs = (MINS_PER_CANDLE[interval] ?? 60) * 60_000;
  const priceAt = (time: number) => {
    const idx = Math.min(klines.length - 1, Math.max(0, Math.floor((time - klines[0].openTime) / candleMs)));
    return klines[idx].open;
  };
  const trades: BacktestTrade[] = simTrades.map(s => applyCosts(s.trade, s.fills, trade, side, fundingRows, priceAt));

  const wins   = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const { winRate, avgProfitPct, avgLossPct, expectedValuePct } = computePnlStats(trades.map(t => t.pnlPct));
  const net = computePnlStats(trades.map(t => t.netPnlPct));
  const fundedTrades = trades.filter(t => !t.fundingMissing);
  const commissionPcts = trades.map(t => t.commissionUsdt / (trade.entryAmountUsdt * (1 + t.gridsFilled)) * 100);
  const fundingPcts    = fundedTrades.map(t => t.fundingUsdt / (trade.entryAmountUsdt * (1 + t.gridsFilled)) * 100);
  const avg = (xs: number[]) => xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  let equity = 0, peak = 0, maxDrawdown = 0;
  const equityCurve: { time: number; equity: number }[] = [{ time: klines[0].openTime, equity: 0 }];

  for (const t of trades) {
    equity += t.netPnlUsdt;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ time: t.exitTime, equity });
  }

  return {
    symbol,
    timeframe: interval,
    totalTrades:    trades.length,
    winningTrades:  wins.length,
    losingTrades:   losses.length,
    winRate,
    avgProfitPct,
    avgLossPct,
    expectedValuePct,
    maxDrawdownPct: trades.length > 0
      ? (maxDrawdown / (trade.entryAmountUsdt * trades.length)) * 100
      : 0,
    totalPnlPct: trades.reduce((a, t) => a + t.pnlPct, 0),
    net,
    avgCommissionPct: avg(commissionPcts),
    avgFundingPct:    avg(fundingPcts),
    fundingMissingTrades: trades.length - fundedTrades.length,
    trades,
    equityCurve
  };
}

import { Kline, StrategyConditions, TradeConfig, BacktestResult, BacktestTrade } from '../types';
import { calcRSI, calc24hChange, candlesPerDay } from './indicator';
import { calcPdfGridPrices, calcPdfAvgEntry, calcPdfStopLoss, calcIsolatedLiquidationPrice, capSlWithLiquidation, truncateGridsToSafeZone, resolveReEntryCooldownHours } from './gridUtils';
import { binanceMaster, pickLeverageBracket, LeverageBracket } from './binance';

interface BacktestOptions {
  conditions: StrategyConditions;
  trade: TradeConfig;
  interval: string;
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
  interval: string
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

  return (
    rsi >= conditions.rsi.min &&
    rsi <= (conditions.rsi.max ?? 100) &&
    priceChange >= conditions.priceChange24h.min &&
    priceChange <= conditions.priceChange24h.max
    // && btcDomPass
  );
}

// ── 단일 트레이드 시뮬레이션 ──────────────────────────────────

function simulateTrade(
  klines: Kline[],
  entryIdx: number,
  trade: TradeConfig,
  interval: string,
  brackets: LeverageBracket[]
): BacktestTrade | null {
  if (entryIdx + 1 >= klines.length) return null;

  const entryPrice = klines[entryIdx + 1].open;

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
    return calcIsolatedLiquidationPrice(marginUsdt, qty, avgEntry, mmr, cum);
  };

  let gridPrices = gridEnabled ? calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing) : [];
  let avgEntryPrice   = entryPrice;
  let takeProfitPrice = entryPrice * (1 - trade.takeProfitPct / 100);
  let stopLossPrice: number;
  if (gridEnabled) {
    const qty = trade.entryAmountUsdt * trade.leverage / entryPrice;
    const liqPrice = estimateLiq(trade.entryAmountUsdt, qty, entryPrice);
    gridPrices = truncateGridsToSafeZone(gridPrices, entryPrice, liqPrice, safetyPct);
    stopLossPrice = calcPdfStopLoss(entryPrice, trade.leverage, gridPrices.length, trade.gridSpacing);
    stopLossPrice = capSlWithLiquidation(stopLossPrice, entryPrice, liqPrice, safetyPct);
  } else {
    stopLossPrice = entryPrice * (1 + trade.stopLossPct / 100);
  }

  let exitPrice = 0;
  let exitTime  = 0;
  let exitReason: BacktestTrade['exitReason'] = 'timeout';
  let gridsFilled = 0;

  for (let j = entryIdx + 2; j <= maxEndIdx; j++) {
    const candle = klines[j];
    const filledNow = gridPrices.filter(p => candle.high >= p).length;

    // 그리드 체결로 평균단가가 오른 만큼 TP/SL도 재계산 (실거래/가상거래와 동일 로직) —
    // 안 하면 SL이 최초 진입가 기준 캡에 고정돼 남은 그리드가 그 캡보다 먼 가격에 있으면
    // 절대 채워질 수 없는 문제가 생겨 실제 동작과 백테스트 결과가 어긋남
    if (filledNow > gridsFilled) {
      gridsFilled     = filledNow;
      avgEntryPrice   = calcPdfAvgEntry(entryPrice, gridPrices.slice(0, gridsFilled));
      const remainingLevels = gridPrices.length - gridsFilled;
      takeProfitPrice = avgEntryPrice * (1 - trade.takeProfitPct / 100);
      stopLossPrice   = calcPdfStopLoss(avgEntryPrice, trade.leverage, remainingLevels, trade.gridSpacing);

      const newTotalUsdt = trade.entryAmountUsdt * (1 + gridsFilled);
      const newQty = newTotalUsdt * trade.leverage / avgEntryPrice;
      const liqPrice = estimateLiq(newTotalUsdt, newQty, avgEntryPrice);
      stopLossPrice = capSlWithLiquidation(stopLossPrice, avgEntryPrice, liqPrice, safetyPct);
    }

    if (candle.high >= stopLossPrice) {
      exitPrice  = stopLossPrice;
      exitTime   = candle.openTime;
      exitReason = 'stopLoss';
      break;
    }
    if (candle.low <= takeProfitPrice) {
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

  const pnlPct  = ((avgEntryPrice - exitPrice) / avgEntryPrice) * 100 * trade.leverage;
  const pnlUsdt = (trade.entryAmountUsdt * (1 + gridsFilled)) * (pnlPct / 100);

  return {
    entryTime: klines[entryIdx + 1].openTime,
    exitTime,
    entryPrice,
    exitPrice,
    avgEntryPrice,
    pnlPct,
    pnlUsdt,
    exitReason,
    gridsFilled
  };
}

// ── 메인 백테스트 함수 ──────────────────────────────────────

export async function runBacktest(
  klines: Kline[],
  options: BacktestOptions,
  symbol: string
): Promise<BacktestResult> {
  const { conditions, trade, interval } = options;
  const trades: BacktestTrade[] = [];

  // 유지증거금률 구간표는 심볼당 하나(포지션 규모별 상수)라 캔들 루프 전에 한 번만 조회 —
  // 마스터 키 미설정/조회 실패 시 빈 배열 → 안전마진 로직은 자동으로 no-op(기존 동작 유지)
  const brackets = trade.gridEnabled !== false
    ? await binanceMaster.getLeverageBracket(symbol).catch(() => [])
    : [];

  let i = 20; // MA20 기준으로 워밍업
  while (i < klines.length - 1) {
    if (checkConditions(klines, i, conditions, interval)) {
      const tradeSim = simulateTrade(klines, i, trade, interval, brackets);
      if (tradeSim) {
        trades.push(tradeSim);
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

  const wins   = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate       = trades.length > 0 ? wins.length / trades.length : 0;
  const avgProfitPct  = wins.length   > 0 ? wins.reduce((a, t)   => a + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct    = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length) : 0;
  const expectedValuePct = winRate * avgProfitPct - (1 - winRate) * avgLossPct;

  let equity = 0, peak = 0, maxDrawdown = 0;
  const equityCurve: { time: number; equity: number }[] = [{ time: klines[0].openTime, equity: 0 }];

  for (const t of trades) {
    equity += t.pnlUsdt;
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
    trades,
    equityCurve
  };
}

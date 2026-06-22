import { Kline, StrategyConditions, TradeConfig, BacktestResult, BacktestTrade } from '../types';
import { calcRSI, calcSMA, calcVolumeRatio, calc24hChange, candlesPerDay, calcBollingerBand } from './indicator';
import { calcPdfGridPrices, calcPdfAvgEntry, calcPdfStopLoss } from './gridUtils';

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
  const volumes = klines.slice(0, idx + 1).map(k => k.volume);
  const cpd = candlesPerDay(interval);

  if (closes.length < 20) return false;

  const rsi         = calcRSI(closes, conditions.rsi.period ?? 14);
  const ma7         = calcSMA(closes, 7);
  const ma20        = calcSMA(closes, 20);
  const volumeRatio = calcVolumeRatio(volumes, 20);
  const last        = closes[closes.length - 1];
  const aboveMa7    = last > ma7;
  const aboveMa20   = last > ma20;
  const bb          = calcBollingerBand(closes);
  const aboveBB     = last > bb.upper;

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
    priceChange <= conditions.priceChange24h.max &&
    volumeRatio >= conditions.volumeMultiplier.min &&
    volumeRatio <= conditions.volumeMultiplier.max &&
    (!conditions.priceAboveMa7  || aboveMa7) &&
    (!conditions.priceAboveMa20 || aboveMa20) &&
    (!conditions.priceAboveBB   || aboveBB)
    // && btcDomPass
  );
}

// ── 단일 트레이드 시뮬레이션 ──────────────────────────────────

function simulateTrade(
  klines: Kline[],
  entryIdx: number,
  trade: TradeConfig,
  interval: string
): BacktestTrade | null {
  if (entryIdx + 1 >= klines.length) return null;

  const entryPrice = klines[entryIdx + 1].open;

  // maxDurationHours: null = 캔들 끝까지, 숫자 = 시간 → 캔들 수 변환
  const maxCandles = trade.maxDurationHours != null
    ? Math.max(1, Math.round(trade.maxDurationHours * 60 / (MINS_PER_CANDLE[interval] ?? 60)))
    : klines.length;
  const maxEndIdx = Math.min(entryIdx + 1 + maxCandles, klines.length - 1);

  // PDF 방식 그리드
  const gridPrices      = calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing);
  const takeProfitPrice = entryPrice * (1 - trade.takeProfitPct / 100);
  const stopLossPrice   = calcPdfStopLoss(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing);

  let exitPrice = 0;
  let exitTime  = 0;
  let exitReason: BacktestTrade['exitReason'] = 'timeout';
  let gridsFilled = 0;

  for (let j = entryIdx + 2; j <= maxEndIdx; j++) {
    const candle = klines[j];
    const filledNow = gridPrices.filter(p => candle.high >= p).length;
    gridsFilled = Math.max(gridsFilled, filledNow);

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

  const filledGridPrices = gridPrices.slice(0, gridsFilled);
  const avgEntryPrice    = calcPdfAvgEntry(entryPrice, filledGridPrices);
  const pnlPct           = ((avgEntryPrice - exitPrice) / avgEntryPrice) * 100 * trade.leverage;
  const pnlUsdt          = (trade.entryAmountUsdt * (1 + gridsFilled)) * (pnlPct / 100);

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

export function runBacktest(
  klines: Kline[],
  options: BacktestOptions,
  symbol: string
): BacktestResult {
  const { conditions, trade, interval } = options;
  const trades: BacktestTrade[] = [];

  let i = 20; // MA20 기준으로 워밍업
  while (i < klines.length - 1) {
    if (checkConditions(klines, i, conditions, interval)) {
      const tradeSim = simulateTrade(klines, i, trade, interval);
      if (tradeSim) {
        trades.push(tradeSim);
        const exitKlineIdx = klines.findIndex(k => k.openTime >= tradeSim.exitTime);
        i = exitKlineIdx > 0 ? exitKlineIdx : i + 1;
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

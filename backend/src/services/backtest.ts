import { Kline, StrategyConditions, TradeConfig, BacktestResult, BacktestTrade } from '../types';
import { calcRSI, calcSMA, calcVolumeRatio, calc24hChange, candlesPerDay } from './indicator';
import { getDominanceAt } from './btcDominanceHistory';

interface BacktestOptions {
  conditions: StrategyConditions;
  trade: TradeConfig;
  interval: string;
}

// ── 조건 충족 여부 체크 ──────────────────────────────────────

function checkConditions(
  klines: Kline[],
  idx: number,
  conditions: StrategyConditions,
  interval: string
): boolean {
  const closes = klines.slice(0, idx + 1).map(k => k.close);
  const volumes = klines.slice(0, idx + 1).map(k => k.volume);
  const cpd = candlesPerDay(interval);

  if (closes.length < 200) return false;

  const rsi = calcRSI(closes, 14);
  const ma200 = calcSMA(closes, 200);
  const volumeRatio = calcVolumeRatio(volumes, 20);
  const change24h = calc24hChange(closes, cpd);
  const aboveMa200 = closes[closes.length - 1] > ma200;

  // BTC 도미넌스: 역사적 데이터가 있으면 그 값 사용, 없으면 조건 skip
  const historicalDom = getDominanceAt(klines[idx].openTime);
  const btcDomPass = historicalDom === null || historicalDom <= conditions.btcDominanceMax;

  return (
    rsi >= conditions.rsi.min &&
    rsi <= conditions.rsi.max &&
    change24h >= conditions.priceChange24h.min &&
    change24h <= conditions.priceChange24h.max &&
    volumeRatio >= conditions.volumeMultiplier.min &&
    volumeRatio <= conditions.volumeMultiplier.max &&
    (!conditions.priceAboveMa200 || aboveMa200) &&
    btcDomPass
  );
}

// ── 단일 트레이드 시뮬레이션 ──────────────────────────────────

function simulateTrade(
  klines: Kline[],
  entryIdx: number,
  trade: TradeConfig
): BacktestTrade | null {
  if (entryIdx + 1 >= klines.length) return null;

  const entryPrice = klines[entryIdx + 1].open; // 다음 캔들 오픈에 진입
  const maxEndIdx = Math.min(entryIdx + 1 + trade.maxDurationHours, klines.length - 1);

  // 그리드 숏 주문 가격들 (진입가 위로 gridSpacing% 간격)
  const gridPrices = Array.from({ length: trade.gridLevels }, (_, i) =>
    entryPrice * (1 + (trade.gridSpacing / 100) * (i + 1))
  );

  const takeProfitPrice = entryPrice * (1 - trade.takeProfitPct / 100);
  const stopLossPrice = gridPrices[gridPrices.length - 1] * (1 + trade.gridSpacing / 100);

  let exitPrice = 0;
  let exitTime = 0;
  let exitReason: BacktestTrade['exitReason'] = 'timeout';
  let gridsFilled = 0;

  for (let j = entryIdx + 2; j <= maxEndIdx; j++) {
    const candle = klines[j];
    const filledNow = gridPrices.filter(p => candle.high >= p).length;
    gridsFilled = Math.max(gridsFilled, filledNow);

    // 손절: 마지막 그리드 위 한 단계 상승
    if (candle.high >= stopLossPrice) {
      exitPrice = stopLossPrice;
      exitTime = candle.openTime;
      exitReason = 'stopLoss';
      break;
    }

    // 익절: 진입가 대비 takeProfitPct% 하락
    if (candle.low <= takeProfitPrice) {
      exitPrice = takeProfitPrice;
      exitTime = candle.closeTime;
      exitReason = 'takeProfit';
      break;
    }

    // 타임아웃
    if (j === maxEndIdx) {
      exitPrice = candle.close;
      exitTime = candle.closeTime;
      exitReason = 'timeout';
    }
  }

  if (exitPrice === 0) return null;

  // 평균 진입가: 초기 진입 + 채워진 그리드 평균
  const filledGridPrices = gridPrices.slice(0, gridsFilled);
  const allEntries = [entryPrice, ...filledGridPrices];
  const avgEntryPrice = allEntries.reduce((a, b) => a + b, 0) / allEntries.length;

  // 숏 포지션 PnL: (평균진입가 - 청산가) / 평균진입가 * 레버리지
  const pnlPct = ((avgEntryPrice - exitPrice) / avgEntryPrice) * 100 * trade.leverage;
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

export function runBacktest(
  klines: Kline[],
  options: BacktestOptions,
  symbol: string
): BacktestResult {
  const { conditions, trade, interval } = options;
  const trades: BacktestTrade[] = [];

  let i = 200; // MA200 계산을 위해 최소 200개 필요
  while (i < klines.length - 1) {
    const conditionsMet = checkConditions(klines, i, conditions, interval);

    if (conditionsMet) {
      const tradeSim = simulateTrade(klines, i, trade);
      if (tradeSim) {
        trades.push(tradeSim);
        // 청산 시점 이후부터 다시 스캔 (겹치는 포지션 방지)
        const exitKlineIdx = klines.findIndex(k => k.openTime >= tradeSim.exitTime);
        i = exitKlineIdx > 0 ? exitKlineIdx : i + 1;
        continue;
      }
    }
    i++;
  }

  // ── 통계 계산 ──────────────────────────────────────────────

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgProfitPct = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0
    ? Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length) : 0;

  // 기댓값 = 승률 × 평균수익 - (1-승률) × 평균손실
  const expectedValuePct = winRate * avgProfitPct - (1 - winRate) * avgLossPct;

  // 에퀴티 커브 & 최대 낙폭
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
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
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

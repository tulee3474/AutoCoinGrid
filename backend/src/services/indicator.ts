import { Kline } from '../types';

// ── RSI (Wilder 방식) ─────────────────────────────────────────

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // 이전 구간 Wilder 평활화
  const seedEnd = closes.length - period - 1;
  for (let i = 1; i <= seedEnd && i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ── SMA / EMA ─────────────────────────────────────────────────

export function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function calcEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── 볼린저 밴드 (SMA ± mult×std) ─────────────────────────────────

export function calcBollingerBand(closes: number[], period = 20, mult = 2): { upper: number; lower: number; middle: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] ?? 0;
    return { upper: last, lower: last, middle: last };
  }
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std  = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, middle: mean };
}

// ── 볼륨 배수 (현재 볼륨 / N일 평균 볼륨) ──────────────────────

export function calcVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const current = volumes[volumes.length - 1];
  const avg = calcSMA(volumes.slice(-period - 1, -1), period);
  return avg === 0 ? 1 : current / avg;
}

// ── 24h 변화율 (candle 개수 기반) ────────────────────────────

export function calc24hChange(closes: number[], candlesPerDay: number): number {
  if (closes.length <= candlesPerDay) return 0;
  const prev = closes[closes.length - 1 - candlesPerDay];
  const curr = closes[closes.length - 1];
  return prev === 0 ? 0 : ((curr - prev) / prev) * 100;
}

// ── 캔들 개수/인터벌 변환 ────────────────────────────────────

export function candlesPerDay(interval: string): number {
  const map: Record<string, number> = {
    '1m': 1440, '5m': 288, '15m': 96, '30m': 48,
    '1h': 24, '4h': 6, '1d': 1
  };
  return map[interval] ?? 24;
}

// ── 종합 지표 계산 ───────────────────────────────────────────

export interface ComputedIndicators {
  rsi14: number;
  ma200: number;
  ma50: number;
  ma20: number;
  ma7: number;
  aboveMa200: boolean;
  aboveMa7: boolean;
  aboveMa20: boolean;
  aboveBB: boolean;
  volumeRatio: number;
  change24h: number;
  currentClose: number;
}

export function computeIndicators(klines: Kline[], interval = '1h', rsiPeriod = 14): ComputedIndicators {
  const closes = klines.map(k => k.close);
  const volumes = klines.map(k => k.volume);
  const cpd = candlesPerDay(interval);
  const bb = calcBollingerBand(closes);
  const last = closes[closes.length - 1];
  const ma7  = calcSMA(closes, 7);
  const ma20 = calcSMA(closes, 20);
  const ma200 = calcSMA(closes, 200);

  return {
    rsi14: calcRSI(closes, rsiPeriod),
    ma200,
    ma50:  calcSMA(closes, 50),
    ma20,
    ma7,
    aboveMa200: last > ma200,
    aboveMa7:   last > ma7,
    aboveMa20:  last > ma20,
    aboveBB: last > bb.upper,
    volumeRatio: calcVolumeRatio(volumes, 20),
    change24h: calc24hChange(closes, cpd),
    currentClose: last
  };
}

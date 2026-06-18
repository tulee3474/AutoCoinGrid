import { binance } from './binance';
import { computeIndicators } from './indicator';
import { StrategyConditions, MarketSnapshot } from '../types';

const EXCLUDE = new Set([
  'BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT',
  'FDUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'WBTCUSDT', 'BTCBUSDT',
  'WBETHUSDT'
]);

export async function scanMarket(
  conditions: StrategyConditions,
  btcDominance: number
): Promise<MarketSnapshot[]> {
  // 1단계: 전체 티커에서 24h 변화율 조건 + 최소 유동성으로 1차 필터
  const tickers = await binance.get24hrTickers();
  const candidates = (tickers as any[])
    .filter(t =>
      t.symbol.endsWith('USDT') &&
      !EXCLUDE.has(t.symbol) &&
      parseFloat(t.quoteVolume) > 200_000 &&          // 하루 $200K 이상 거래
      parseFloat(t.priceChangePercent) >= conditions.priceChange24h.min &&
      parseFloat(t.priceChangePercent) <= conditions.priceChange24h.max
    )
    .map(t => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume24h: parseFloat(t.quoteVolume)
    }))
    .sort((a, b) => b.change24h - a.change24h); // 상승률 높은 순

  if (candidates.length === 0) return [];

  // 2단계: 후보 코인들의 RSI / MA200 / 볼륨배수 계산 (병렬)
  const results: MarketSnapshot[] = [];

  await Promise.allSettled(
    candidates.map(async ticker => {
      try {
        const klines = await binance.getKlines(ticker.symbol, conditions.rsi.timeframe, 250);
        if (klines.length < 50) return;

        const ind = computeIndicators(klines, conditions.rsi.timeframe);

        // 조건 충족 여부별 점수 (0~100)
        const scores = [
          (ind.rsi14 >= conditions.rsi.min && ind.rsi14 <= conditions.rsi.max) ? 30 : 0,
          (ticker.change24h >= conditions.priceChange24h.min)                   ? 25 : 0,
          (ind.volumeRatio >= conditions.volumeMultiplier.min)                  ? 25 : 0,
          (!conditions.priceAboveMa200 || ind.aboveMa200)                       ? 10 : 0,
          (btcDominance <= conditions.btcDominanceMax)                           ? 10 : 0,
        ];
        const signalScore = scores.reduce((a, b) => a + b, 0);

        results.push({
          symbol: ticker.symbol,
          price: ticker.price,
          change24h: ticker.change24h,
          volume24h: ticker.volume24h,
          rsi14: ind.rsi14,
          volumeRatio: ind.volumeRatio,
          aboveMa200: ind.aboveMa200,
          signalScore
        });
      } catch {
        // 개별 실패 무시
      }
    })
  );

  // 시그널 스코어 높은 순 정렬
  return results.sort((a, b) => b.signalScore - a.signalScore);
}

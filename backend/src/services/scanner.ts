import { binance } from './binance';
import { computeIndicators } from './indicator';
import { StrategyConditions, MarketSnapshot } from '../types';

const EXCLUDE = new Set([
  'BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT',
  'FDUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'WBTCUSDT', 'BTCBUSDT',
  'WBETHUSDT'
]);

// kline 간격(분) → 가격 변화 기준 시간(분) 변환
function candlesForPeriod(period: '1h' | '4h' | '24h', klineInterval: string): number {
  const minsPerCandle: Record<string, number> = {
    '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
  };
  const targetMins: Record<string, number> = { '1h': 60, '4h': 240, '24h': 1440 };
  return Math.max(1, Math.round(targetMins[period] / (minsPerCandle[klineInterval] ?? 60)));
}

export async function scanMarket(
  conditions: StrategyConditions,
  _btcDominance: number
): Promise<MarketSnapshot[]> {
  const priceChangeTf = conditions.priceChangeTimeframe ?? '24h';

  // 1단계: 전체 티커에서 유동성 + 선물 가능 여부 1차 필터
  // spot이 아닌 선물 API 사용 (spot rate-limit/IP 차단과 분리된 별도 weight 한도)
  const [tickers, futuresSymbols] = await Promise.all([
    binance.getFutures24hrTickers(),
    binance.getFuturesSymbols()
  ]);

  const candidates = (tickers as any[])
    .filter(t => {
      if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
      if (!futuresSymbols.has(t.symbol)) return false;              // 선물 거래 가능 코인만
      if (parseFloat(t.quoteVolume) <= 200_000) return false;       // 하루 $200K 이상 거래
      // 24h 모드에서만 가격 변화율로 사전 필터 (1h/4h는 kline 단계에서 체크)
      if (priceChangeTf === '24h') {
        const ch = parseFloat(t.priceChangePercent);
        return ch >= conditions.priceChange24h.min && ch <= conditions.priceChange24h.max;
      }
      return true;
    })
    .map(t => ({
      symbol:    t.symbol,
      price:     parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent),
      volume24h: parseFloat(t.quoteVolume)
    }))
    .sort((a, b) => b.change24h - a.change24h);

  if (candidates.length === 0) return [];

  // 2단계: 후보 코인들의 지표 계산 (동시 10개 제한)
  // 스코어 배점: RSI 30 + 가격변화 25 + 볼륨 20 + MA7 5 + MA20 5 + BB 15 = 100
  const results: MarketSnapshot[] = [];
  const queue = [...candidates];
  const CONCURRENCY = 10;
  const workers = Array(CONCURRENCY).fill(null).map(async () => {
    while (queue.length > 0) {
      const ticker = queue.shift()!;
      try {
        const klines = await binance.getFuturesKlines(ticker.symbol, conditions.rsi.timeframe, 250);
        if (klines.length < 20) continue;

        const ind = computeIndicators(klines, conditions.rsi.timeframe, conditions.rsi.period ?? 14);

        // 가격 변화 계산: 지정된 타임프레임 기준
        let actualChange = ticker.change24h;
        if (priceChangeTf !== '24h') {
          const n = candlesForPeriod(priceChangeTf, conditions.rsi.timeframe);
          const closes = klines.map(k => k.close);
          if (closes.length > n) {
            actualChange = ((closes[closes.length - 1] - closes[closes.length - 1 - n]) /
              closes[closes.length - 1 - n]) * 100;
          }
        }

        const changePass = actualChange >= conditions.priceChange24h.min &&
                           actualChange <= conditions.priceChange24h.max;

        const scores = [
          (ind.rsi14 >= conditions.rsi.min)                            ? 30 : 0, // RSI min만 (max 제거)
          changePass                                                    ? 25 : 0, // 가격 변화
          (ind.volumeRatio >= conditions.volumeMultiplier.min)         ? 20 : 0, // 볼륨
          (!conditions.priceAboveMa7  || ind.aboveMa7)                ? 5  : 0, // MA7
          (!conditions.priceAboveMa20 || ind.aboveMa20)               ? 5  : 0, // MA20
          // BTC 도미넌스 조건 비활성화 (나중에 추가할 수 있음)
          // (btcDominance <= conditions.btcDominanceMax)              ? 10 : 0,
          (!conditions.priceAboveBB   || ind.aboveBB)                 ? 15 : 0, // 볼린저 상단
        ];
        const signalScore = scores.reduce((a, b) => a + b, 0);

        results.push({
          symbol:     ticker.symbol,
          price:      ticker.price,
          change24h:  actualChange,
          volume24h:  ticker.volume24h,
          rsi14:      ind.rsi14,
          volumeRatio: ind.volumeRatio,
          aboveMa200: ind.aboveMa200,
          aboveBB:    ind.aboveBB,
          signalScore
        });
      } catch {
        // 개별 실패 무시
      }
    }
  });
  await Promise.allSettled(workers);

  return results.sort((a, b) => b.signalScore - a.signalScore);
}

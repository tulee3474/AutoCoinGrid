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

// 1h/4h 모드는 유동성 통과 후보 전부(시장 전체에 가까움)의 캔들을 매 사이클 받아와야 해서
// weight 소모가 큼 — 짝수 사이클에서만 24h 변화율로 느슨하게 사전 필터링해 후보를 크게 줄이고,
// 홀수 사이클엔 원래대로 전체를 훑어서 "24h로는 평범해 보이지만 최근 4h에 크게 움직인" 코인을
// 최소 2사이클(약 2분)에 한 번은 놓치지 않도록 함
const SCAN_CYCLE_WINDOW_MS = 60_000;
function isPrefilterCycle(): boolean {
  return Math.floor(Date.now() / SCAN_CYCLE_WINDOW_MS) % 2 === 0;
}

export async function scanMarket(
  conditions: StrategyConditions,
  _btcDominance: number
): Promise<MarketSnapshot[]> {
  const priceChangeTf = conditions.priceChangeTimeframe ?? '24h';

  // 1단계: 전체 티커에서 유동성 + 선물 가능 여부 1차 필터
  // spot이 아닌 선물 API 사용 (spot rate-limit/IP 차단과 분리된 별도 weight 한도)
  const [tickers, futuresSymbols, onboardDates] = await Promise.all([
    binance.getFutures24hrTickers(),
    binance.getFuturesSymbols(),
    binance.getFuturesOnboardDates()
  ]);

  const minListingMs = conditions.minListingDays ? conditions.minListingDays * 86_400_000 : 0;
  const prefilterActive = priceChangeTf !== '24h' && isPrefilterCycle();

  const candidates = (tickers as any[])
    .filter(t => {
      if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
      if (!futuresSymbols.has(t.symbol)) return false;              // 선물 거래 가능 코인만
      if (parseFloat(t.quoteVolume) <= 200_000) return false;       // 하루 $200K 이상 거래
      // 상장 초기 코인 제외 (변동성 과도 — 상장 빔 방지)
      if (minListingMs > 0) {
        const onboardDate = onboardDates.get(t.symbol);
        if (onboardDate && Date.now() - onboardDate < minListingMs) return false;
      }
      // 24h 모드는 가격 변화율로 바로 필터 (weight 추가 소모 없음, 이미 받은 티커 데이터)
      if (priceChangeTf === '24h') {
        const ch = parseFloat(t.priceChangePercent);
        return ch >= conditions.priceChange24h.min && ch <= conditions.priceChange24h.max;
      }
      // 1h/4h 모드: 짝수 사이클에서만 24h 변화율로 느슨하게(목표치의 30%, 최소 5%) 사전 필터 —
      // 후보가 시장 전체에 가까워 캔들 요청 weight가 큰 걸 줄임. 홀수 사이클은 원래대로 전체 스캔
      if (prefilterActive) {
        const loosePct = Math.max(5, conditions.priceChange24h.min * 0.3);
        if (parseFloat(t.priceChangePercent) < loosePct) return false;
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
        // 최근 N일 내 일봉 기준 큰 폭 급락 이력이 있으면 제외 — 이미 한 번 급락한 코인의
        // 반등(되돌림)을 급등 추세로 오인해 진입하는 것을 방지
        // TEMP: 후보 코인마다 1d klines를 추가로 요청해 Binance IP 차단 재발 원인으로 의심돼
        // 임시 비활성화 (2026-07-10) — 원인 확정되면 복구
        // if (conditions.noRecentCrash) {
        //   const { days, dropPct } = conditions.noRecentCrash;
        //   const dailyKlines = await binance.getFuturesKlines(ticker.symbol, '1d', days + 1);
        //   const dailyCloses = dailyKlines.map(k => k.close);
        //   let crashed = false;
        //   for (let i = 1; i < dailyCloses.length; i++) {
        //     const dayChange = ((dailyCloses[i] - dailyCloses[i - 1]) / dailyCloses[i - 1]) * 100;
        //     if (dayChange <= -dropPct) { crashed = true; break; }
        //   }
        //   if (crashed) continue;
        // }

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
          (ind.rsi14 >= conditions.rsi.min) ? 50 : 0, // RSI min만 (max 제거)
          changePass                        ? 50 : 0, // 가격 변화
          // BTC 도미넌스 조건 비활성화 (나중에 추가할 수 있음)
          // (btcDominance <= conditions.btcDominanceMax) ? 10 : 0,
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

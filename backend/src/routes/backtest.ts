import { Router } from 'express';
import { binance } from '../services/binance';
import { runBacktest } from '../services/backtest';
import { StrategyConditions, TradeConfig } from '../types';

const router = Router();

// 안전한 병렬 처리 헬퍼: 최대 concurrency 개 동시 실행
async function batchSettled<T>(
  items: string[],
  fn: (item: string) => Promise<T>,
  concurrency = 40,
  delayMs = 300
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(
      ...settled
        .filter(r => r.status === 'fulfilled')
        .map(r => (r as PromiseFulfilledResult<T>).value)
    );
    if (i + concurrency < items.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

// POST /api/backtest/run - 단일 코인 상세 백테스트
// BTC 도미넌스: backend/data/btc_dominance.csv 있으면 캔들별 조회, 없으면 조건 skip
router.post('/run', async (req, res) => {
  const { symbol, interval = '1h', limit = 1500, conditions, trade } = req.body;
  if (!symbol || !conditions || !trade) {
    return res.status(400).json({ error: 'symbol, conditions, trade 필요' });
  }
  try {
    // 선물 전용 상장 코인(예: TAIKO)은 스팟에 없어 getKlines(스팟) 호출 시 400 Invalid symbol —
    // 스캐너/실거래와 동일하게 선물 캔들 사용
    const klines = await binance.getFuturesKlines(symbol, interval, limit);
    const result = runBacktest(klines, { conditions, trade, interval }, symbol);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.response?.data?.msg ?? e.message });
  }
});

// POST /api/backtest/validate
// 전략 조건이 과거에 몇 번 발생했고 승률이 어떤지 — 전체 알트코인 대상
router.post('/validate', async (req, res) => {
  const { conditions, trade }: { conditions: StrategyConditions; trade: TradeConfig } = req.body;
  if (!conditions || !trade) {
    return res.status(400).json({ error: 'conditions, trade 필요' });
  }

  const interval = conditions.rsi?.timeframe || '1h';

  // 제외할 코인 (스테이블, 래핑, 메이저)
  const EXCLUDE = new Set([
    'BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT',
    'FDUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'WBTCUSDT', 'BTCBUSDT',
    'WBETHUSDT', 'LDOUSDT'
  ]);

  try {
    // 전체 USDT 페어 조회 — 선물 전용 상장 코인(스캐너/실거래 대상)도 포함되도록 선물 API 사용
    const [tickers, onboardDates] = await Promise.all([
      binance.getFutures24hrTickers(),
      binance.getFuturesOnboardDates()
    ]);
    const minListingMs = conditions.minListingDays ? conditions.minListingDays * 86_400_000 : 0;
    const allAlt = (tickers as any[])
      .filter(t => {
        if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) <= 200_000) return false;   // 최소 유동성 (하루 $200K 이상)
        // 실제 스캐너와 동일하게 상장 초기 코인 제외 — 반영 안 하면 승률 통계가 실거래와 어긋남
        if (minListingMs > 0) {
          const onboardDate = onboardDates.get(t.symbol);
          if (onboardDate && Date.now() - onboardDate < minListingMs) return false;
        }
        return true;
      })
      .map(t => t.symbol);

    // 배치 처리 (40개씩, Binance rate limit 보호)
    // interval에 따라 1500캔들이 커버하는 기간이 자동으로 달라짐
    // 1h=62일, 4h=250일, 1d=약 4년
    const allResults = await batchSettled(
      allAlt,
      async (symbol) => {
        const klines = await binance.getFuturesKlines(symbol, interval, 1500);
        return runBacktest(klines, { conditions, trade, interval }, symbol);
      },
      40,
      300
    );

    const validResults = allResults.filter(r => r.totalTrades > 0);

    if (validResults.length === 0) {
      return res.json({
        totalSignals: 0, wins: 0, winRate: 0,
        expectedValuePct: 0, avgProfitPct: 0, avgLossPct: 0,
        coinsAnalyzed: allAlt.length, coinsWithSignal: 0,
        interval, perCoin: [],
        recentTotalSignals: 0, recentWins: 0,
        message: '조건을 충족한 신호가 없습니다. 조건 범위를 넓혀보세요.'
      });
    }

    const recentCutoff = Date.now() - 62 * 24 * 60 * 60 * 1000;
    const allTrades  = validResults.flatMap(r => r.trades);
    const winTrades  = allTrades.filter(t => t.pnlPct > 0);
    const lossTrades = allTrades.filter(t => t.pnlPct <= 0);
    const totalSignals  = allTrades.length;
    const wins          = winTrades.length;
    const winRate       = totalSignals > 0 ? wins / totalSignals : 0;
    const avgProfitPct  = winTrades.length  > 0 ? winTrades.reduce((s, t)  => s + t.pnlPct, 0) / winTrades.length  : 0;
    const avgLossPct    = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length) : 0;
    const expectedValuePct = winRate * avgProfitPct - (1 - winRate) * avgLossPct;

    const recentAllTrades  = allTrades.filter(t => t.entryTime >= recentCutoff);
    const recentWinTrades  = recentAllTrades.filter(t => t.pnlPct > 0);
    const recentLossTrades = recentAllTrades.filter(t => t.pnlPct <= 0);
    const recentTotalSignals   = recentAllTrades.length;
    const recentWins           = recentWinTrades.length;
    const recentWinRate        = recentTotalSignals > 0 ? recentWins / recentTotalSignals : 0;
    const recentAvgProfitPct   = recentWinTrades.length  > 0 ? recentWinTrades.reduce((s, t)  => s + t.pnlPct, 0) / recentWinTrades.length  : 0;
    const recentAvgLossPct     = recentLossTrades.length > 0 ? Math.abs(recentLossTrades.reduce((s, t) => s + t.pnlPct, 0) / recentLossTrades.length) : 0;
    const recentExpectedValuePct = recentWinRate * recentAvgProfitPct - (1 - recentWinRate) * recentAvgLossPct;

    res.json({
      totalSignals, wins, winRate,
      expectedValuePct, avgProfitPct, avgLossPct,
      coinsAnalyzed: allAlt.length,
      coinsWithSignal: validResults.length,
      interval,
      recentTotalSignals,
      recentWins,
      recentWinRate,
      recentAvgProfitPct,
      recentAvgLossPct,
      recentExpectedValuePct,
      perCoin: validResults
        .map(r => {
          const recentTrades = r.trades.filter(t => t.entryTime >= recentCutoff);
          return {
            symbol: r.symbol,
            signals: r.totalTrades,
            wins: r.winningTrades,
            winRate: r.winRate,
            recentSignals: recentTrades.length,
            recentWins: recentTrades.filter(t => t.pnlPct > 0).length,
          };
        })
        .sort((a, b) => b.signals - a.signals)
        .slice(0, 15)
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

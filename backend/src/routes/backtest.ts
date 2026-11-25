import { Router } from 'express';
import { binance } from '../services/binance';
import { runBacktest, computePnlStats, computeUsdStats } from '../services/backtest';
import { selectTopVolume } from '../services/candidateFilter';
import { StrategyConditions, TradeConfig, Kline, Side } from '../types';
import { requireAuth, AuthRequest } from '../middleware/auth';
import prisma from '../lib/prisma';
import { fundingCostAt } from '../services/fundingFilter';
import { liveNetPct } from '../services/ml/liveNet';

const router = Router();

// btcKlinesFull(끝 시점이 대상 코인과 동일하다고 가정)을 대상 코인의 klines 길이에 맞춰 뒤에서부터
// 잘라 정렬 — 대상 코인이 BTC보다 늦게 상장돼 캔들 수가 적은 경우를 위함
function alignBtcKlines(btcKlinesFull: Kline[] | undefined, targetLength: number): Kline[] | undefined {
  if (!btcKlinesFull) return undefined;
  return btcKlinesFull.length >= targetLength
    ? btcKlinesFull.slice(btcKlinesFull.length - targetLength)
    : btcKlinesFull;
}

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
  const { symbol, interval = '1h', limit = 1500, conditions, trade, side = 'SHORT' } = req.body;
  if (!symbol || !conditions || !trade) {
    return res.status(400).json({ error: 'symbol, conditions, trade 필요' });
  }
  try {
    // 선물 전용 상장 코인(예: TAIKO)은 스팟에 없어 getKlines(스팟) 호출 시 400 Invalid symbol —
    // 스캐너/실거래와 동일하게 선물 캔들 사용
    const klines = await binance.getFuturesKlines(symbol, interval, limit);

    let btcKlines: Kline[] | undefined;
    if (conditions.btcChangeFilter) {
      btcKlines = alignBtcKlines(await binance.getFuturesKlines('BTCUSDT', interval, limit).catch(() => undefined), klines.length);
    }

    const result = await runBacktest(klines, { conditions, trade, interval, side, btcKlines }, symbol);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.response?.data?.msg ?? e.message });
  }
});

// POST /api/backtest/validate
// 전략 조건이 과거에 몇 번 발생했고 승률이 어떤지 — 전체 알트코인 대상
router.post('/validate', async (req, res) => {
  const { conditions, trade, side = 'SHORT' }: { conditions: StrategyConditions; trade: TradeConfig; side?: 'LONG' | 'SHORT' } = req.body;
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
    // 스캐너와 동일하게 거래량 상위 N%만 — 스캐너가 실제로 보는 코인 풀과 맞춰야 승률 통계가 실거래와 일치
    const allAlt = selectTopVolume(
      (tickers as any[]).filter(t => {
        if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
        if (parseFloat(t.quoteVolume) <= 200_000) return false;   // 최소 유동성 (하루 $200K 이상)
        // 실제 스캐너와 동일하게 상장 초기 코인 제외 — 반영 안 하면 승률 통계가 실거래와 어긋남
        if (minListingMs > 0) {
          const onboardDate = onboardDates.get(t.symbol);
          if (onboardDate && Date.now() - onboardDate < minListingMs) return false;
        }
        return true;
      }),
      conditions.candidateTopPct
    ).map(t => t.symbol);

    // BTC 변동률 필터가 설정돼 있으면 심볼당 한 번씩 다시 받을 필요 없이 여기서 한 번만 조회 —
    // 코인별로는 klines 길이에 맞춰 뒤에서부터 잘라 정렬해서 씀 (상장일이 BTC보다 늦은 코인 대응)
    const btcKlinesFull = conditions.btcChangeFilter
      ? await binance.getFuturesKlines('BTCUSDT', interval, 1500).catch(() => undefined)
      : undefined;

    // 배치 처리 (40개씩, Binance rate limit 보호)
    // interval에 따라 1500캔들이 커버하는 기간이 자동으로 달라짐
    // 1h=62일, 4h=250일, 1d=약 4년
    // 캔들 조회는 weight 예산(getFuturesKlinesPaced) 안에서만 — 예전엔 40개씩 몰아 받다가 분당 한도를
    // 넘어 429가 나면 남은 코인이 조용히 빠져서, 같은 전략도 실행할 때마다 표본이 달라져 EV가 크게 흔들렸음.
    // 이제는 한도에 닿으면 기다렸다 받고, 그래도 실패한 코인 수는 응답(coinsFailed)으로 알려줌
    const failedSymbols: string[] = [];
    const allResults = await batchSettled(
      allAlt,
      async (symbol) => {
        try {
          const klines = await binance.getFuturesKlinesPaced(symbol, interval, 1500);
          const btcKlines = alignBtcKlines(btcKlinesFull, klines.length);
          return await runBacktest(klines, { conditions, trade, interval, side, btcKlines }, symbol);
        } catch (e) {
          failedSymbols.push(symbol);
          throw e;
        }
      },
      10,
      0
    );
    if (failedSymbols.length > 0) {
      console.warn(`[validate] 캔들 조회 실패로 제외된 코인 ${failedSymbols.length}개: ${failedSymbols.slice(0, 20).join(', ')}`);
    }

    const validResults = allResults.filter(r => r.totalTrades > 0);

    if (validResults.length === 0) {
      return res.json({
        totalSignals: 0, wins: 0, winRate: 0,
        expectedValuePct: 0, avgProfitPct: 0, avgLossPct: 0,
        coinsAnalyzed: allAlt.length, coinsWithSignal: 0, coinsFailed: failedSymbols.length,
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

    // 순손익(펀딩피·수수료 반영) 기준 — 위 값들은 가격 기준(기존과 동일)
    const net       = computePnlStats(allTrades.map(t => t.netPnlPct));
    const recentNet = computePnlStats(recentAllTrades.map(t => t.netPnlPct));
    const marginOf  = (t: typeof allTrades[number]) => trade.entryAmountUsdt * (1 + t.gridsFilled);
    const fundedTrades = allTrades.filter(t => !t.fundingMissing);
    const avgOf = (xs: number[]) => xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const avgCommissionPct = avgOf(allTrades.map(t => t.commissionUsdt / marginOf(t) * 100));
    const avgFundingPct    = avgOf(fundedTrades.map(t => t.fundingUsdt / marginOf(t) * 100));

    res.json({
      totalSignals, wins, winRate,
      expectedValuePct, avgProfitPct, avgLossPct,
      coinsAnalyzed: allAlt.length,
      coinsFailed: failedSymbols.length,
      coinsWithSignal: validResults.length,
      interval,
      recentTotalSignals,
      recentWins,
      recentWinRate,
      recentAvgProfitPct,
      recentAvgLossPct,
      recentExpectedValuePct,
      net, recentNet,
      avgCommissionPct, avgFundingPct,
      fundingMissingTrades: allTrades.length - fundedTrades.length,
      // 금액 기준 (거래당 평균 순손익 ÷ 진입금) — 그리드로 증거금이 커진 손절의 무게까지 반영
      usd:       computeUsdStats(allTrades.map(t => ({ netUsdt: t.netPnlUsdt, baseUsdt: trade.entryAmountUsdt }))),
      recentUsd: computeUsdStats(recentAllTrades.map(t => ({ netUsdt: t.netPnlUsdt, baseUsdt: trade.entryAmountUsdt }))),
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

// POST /api/backtest/funding-whatif { strategyId, source: 'live'|'paper', days } — 펀딩 비용 필터 사후 점검
// 이 전략의 과거 거래마다 "진입 시각의 하루 펀딩 비용"을 바이낸스 공개 펀딩비 이력으로 다시 계산해 돌려줌.
// 상한값에 따른 걸러짐/결과 계산은 화면에서 즉시 (값을 바꿔볼 때마다 다시 조회하지 않도록)
router.post('/funding-whatif', requireAuth, async (req: AuthRequest, res) => {
  const strategy = await prisma.strategy.findFirst({
    where: { id: String(req.body?.strategyId ?? ''), userId: req.userId },
    select: { id: true, name: true, side: true },
  });
  if (!strategy) return res.status(404).json({ error: '전략을 찾을 수 없음' });
  const source = req.body?.source === 'paper' ? 'paper' : 'live';
  const days = Math.min(365, Math.max(7, Number(req.body?.days) || 90));
  const since = new Date(Date.now() - days * 86_400_000);
  const side = (strategy.side as Side) ?? 'SHORT';

  type Row = { symbol: string; entryTime: Date; exitTime: Date; exitReason: string; netUsdt: number; netPct: number; fundingUsdt: number | null };
  let trades: Row[] = [];
  if (source === 'live') {
    const logs = await prisma.liveTradeLog.findMany({ where: { userId: req.userId, strategyName: strategy.name, side, entryTime: { gte: since } } });
    trades = logs.map(l => ({
      symbol: l.symbol, entryTime: l.entryTime, exitTime: l.exitTime, exitReason: l.exitReason,
      netUsdt: l.pnlUsdt + l.fundingFee + l.commission, netPct: liveNetPct(l), fundingUsdt: l.feesSynced ? l.fundingFee : null,
    }));
  } else {
    const wallet = await prisma.paperWallet.findUnique({ where: { userId: req.userId }, select: { id: true } });
    const logs = wallet ? await prisma.paperTradeLog.findMany({ where: { walletId: wallet.id, strategyName: strategy.name, side, entryTime: { gte: since } } }) : [];
    // 가상 지갑 기록엔 펀딩·수수료가 없음 → 가격 손익 기준
    trades = logs.map(l => ({ symbol: l.symbol, entryTime: l.entryTime, exitTime: l.exitTime, exitReason: l.exitReason, netUsdt: l.pnlUsdt, netPct: l.pnlPct, fundingUsdt: null }));
  }

  // 코인별로 펀딩비 이력 1번씩 (동시 4개, 바이낸스 요청 한도 안에서 대기)
  const bySym = new Map<string, Row[]>();
  for (const t of trades) (bySym.get(t.symbol) ?? bySym.set(t.symbol, []).get(t.symbol)!).push(t);
  const out: any[] = [];
  let failed = 0;
  const queue = [...bySym.entries()];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let item; (item = queue.shift()); ) {
      const [sym, list] = item;
      const minT = Math.min(...list.map(t => t.entryTime.getTime()));
      const rows = await binance.getFundingRateHistory(sym, minT - 2 * 86_400_000, true).catch(() => null);
      if (!rows) failed++;
      for (const t of list) {
        const c = fundingCostAt(rows, t.entryTime.getTime(), side);
        out.push({
          symbol: sym, entryTime: t.entryTime.getTime(), exitTime: t.exitTime.getTime(), exitReason: t.exitReason,
          netUsdt: t.netUsdt, netPct: t.netPct, fundingUsdt: t.fundingUsdt,
          costPerDayPct: c?.costPerDayPct ?? null, ratePct: c?.ratePct ?? null, intervalH: c?.intervalH ?? null,
        });
      }
    }
  }));
  out.sort((a, b) => b.entryTime - a.entryTime);
  res.json({ source, days, side, trades: out, symbolsFailed: failed });
});

export default router;

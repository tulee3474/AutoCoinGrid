import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { binance } from '../services/binance';
import { getOrCreateWallet, resetPaperWallet, closePaperPosition } from '../services/paperWallet';
import { isPaperRunning, startPaperScanner, stopPaperScanner, getPaperLog } from '../services/autoScanner';
import prisma from '../lib/prisma';

const router = Router();

// 연속된 동일 심볼+전략 SL 거래를 묶어서 합산 P&L로 승률 계산
function groupedWinRate(logs: { symbol: string; strategyName: string; exitReason: string; pnlUsdt: number; exitTime: Date }[]): number {
  if (logs.length === 0) return 0;
  const sorted = [...logs].sort((a, b) => a.exitTime.getTime() - b.exitTime.getTime());
  const groups: number[] = [];
  let i = 0;
  while (i < sorted.length) {
    let pnl = sorted[i].pnlUsdt;
    let j = i + 1;
    while (j < sorted.length &&
           sorted[j - 1].exitReason === 'stopLoss' &&
           sorted[j].symbol === sorted[j - 1].symbol &&
           sorted[j].strategyName === sorted[j - 1].strategyName) {
      pnl += sorted[j].pnlUsdt;
      j++;
    }
    groups.push(pnl);
    i = j;
  }
  const wins = groups.filter(p => p > 0).length;
  return groups.length > 0 ? wins / groups.length : 0;
}

let _broadcast: (data: unknown) => void = () => {};
export function setPaperBroadcast(fn: (data: unknown) => void) {
  _broadcast = fn;
}

// ── 지갑 요약 ──────────────────────────────────────────────────
router.get('/wallet', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet          = await getOrCreateWallet(req.userId!);
  const totalRealizedPnl = wallet.tradeLogs.reduce((s, t) => s + t.pnlUsdt, 0);
  const winRate          = groupedWinRate(wallet.tradeLogs);

  let unrealizedPnl = 0;
  if (wallet.openPositions.length > 0) {
    try {
      // 마지막 체결가(lastPrice)가 아니라 Binance가 PnL/ROE 계산에 쓰는 markPrice 기준으로 맞춤
      const indices  = await binance.getFuturesPremiumIndex() as any[];
      const priceMap = new Map<string, number>(indices.map((m: any) => [m.symbol, parseFloat(m.markPrice)]));
      wallet.openPositions.forEach(pos => {
        const price = priceMap.get(pos.symbol);
        if (price) {
          // 그리드 추가진입이 있으면 avgEntryPrice/totalEntryUsdt 기준으로 계산 (청산 시 계산과 동일)
          const avgEntry  = pos.avgEntryPrice  > 0 ? pos.avgEntryPrice  : pos.entryPrice;
          const totalUsdt = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;
          const pnlPct = ((avgEntry - price) / avgEntry) * 100 * pos.leverage;
          unrealizedPnl += totalUsdt * pnlPct / 100;
        }
      });
    } catch {}
  }

  res.json({
    balance:            wallet.balance,
    initialBalance:     wallet.initialBalance,
    openPositionsCount: wallet.openPositions.length,
    totalTradesCount:   wallet.tradeLogs.length,
    realizedPnlUsdt:    totalRealizedPnl,
    unrealizedPnlUsdt:  unrealizedPnl,
    totalEquity:        wallet.balance + unrealizedPnl,
    winRate
  });
});

// ── 오픈 포지션 (실시간 PnL 포함) ─────────────────────────────
router.get('/positions', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId!);
  if (wallet.openPositions.length === 0) return res.json([]);

  try {
    const indices  = await binance.getFuturesPremiumIndex() as any[];
    const priceMap = new Map<string, number>(indices.map((m: any) => [m.symbol, parseFloat(m.markPrice)]));
    const positions = wallet.openPositions.map(pos => {
      const currentPrice = priceMap.get(pos.symbol) ?? pos.entryPrice;
      // 그리드 추가진입이 있으면 avgEntryPrice/totalEntryUsdt 기준으로 미실현 PnL 계산 (청산 시 계산과 동일)
      const avgEntry  = pos.avgEntryPrice  > 0 ? pos.avgEntryPrice  : pos.entryPrice;
      const totalUsdt = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;
      const pnlPct  = ((avgEntry - currentPrice) / avgEntry) * 100 * pos.leverage;
      const pnlUsdt = totalUsdt * pnlPct / 100;
      return { ...pos, currentPrice, pnlPct, pnlUsdt };
    });
    res.json(positions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 거래 로그 ──────────────────────────────────────────────────
router.get('/logs', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId!);
  const limit  = Math.min(parseInt(req.query.limit as string) || 50, 500);
  res.json(wallet.tradeLogs.slice(0, limit));
});

// ── 지갑 초기화 ────────────────────────────────────────────────
router.post('/reset', requireAuth, async (req: AuthRequest, res: Response) => {
  await resetPaperWallet(req.userId!);
  res.json({ ok: true });
});

// ── 거래 로그 초기화 ───────────────────────────────────────────
router.delete('/logs', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId!);
  await prisma.paperTradeLog.deleteMany({ where: { walletId: wallet.id } });
  res.json({ ok: true });
});

// ── 포지션 수동 청산 ───────────────────────────────────────────
router.delete('/positions/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId!);
  const pos    = wallet.openPositions.find(p => p.id === req.params.id);
  if (!pos) return res.status(404).json({ error: 'position not found' });

  try {
    const indices = await binance.getFuturesPremiumIndex() as any[];
    const index   = indices.find(m => m.symbol === pos.symbol);
    const price   = index ? parseFloat(index.markPrice) : pos.entryPrice;
    const log     = await closePaperPosition(req.userId!, req.params.id, price, 'manual');
    res.json(log);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── 전략별 승률 통계 ───────────────────────────────────────────
router.get('/strategy-stats', requireAuth, async (req: AuthRequest, res: Response) => {
  const wallet = await getOrCreateWallet(req.userId!);
  const allLogs = await prisma.paperTradeLog.findMany({
    where:   { walletId: wallet.id },
    orderBy: { exitTime: 'asc' },
    select:  { symbol: true, strategyName: true, exitReason: true, pnlUsdt: true, exitTime: true }
  });

  const byStrategy = new Map<string, typeof allLogs>();
  for (const log of allLogs) {
    if (!byStrategy.has(log.strategyName)) byStrategy.set(log.strategyName, []);
    byStrategy.get(log.strategyName)!.push(log);
  }

  const result: Record<string, { winRate: number; trades: number }> = {};
  for (const [name, logs] of byStrategy) {
    result[name] = { winRate: groupedWinRate(logs), trades: logs.length };
  }
  res.json(result);
});

// ── 스캐너 상태 + 로그 ─────────────────────────────────────────
router.get('/scanner/status', requireAuth, (req: AuthRequest, res: Response) => {
  res.json({ running: isPaperRunning(req.userId!), log: getPaperLog(req.userId!).slice(0, 30) });
});

router.post('/scanner/start', requireAuth, (req: AuthRequest, res: Response) => {
  startPaperScanner(req.userId!, _broadcast);
  res.json({ running: true });
});

router.post('/scanner/stop', requireAuth, (req: AuthRequest, res: Response) => {
  stopPaperScanner(req.userId!);
  res.json({ running: false });
});

export default router;

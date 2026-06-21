import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  startLiveScanner, stopLiveScanner, forceStopLiveScanner,
  isLiveRunning, isLiveStopping,
  getLiveLog, getLivePositions, getLiveTradeLogs, closeLivePositionManual
} from '../services/liveTrader';
import { binance } from '../services/binance';
import prisma from '../lib/prisma';

const router = Router();
let broadcastFn: (data: unknown) => void = () => {};

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

export function setLiveBroadcast(fn: (data: unknown) => void) {
  broadcastFn = fn;
}

// GET /api/live/status
router.get('/status', requireAuth, async (req: AuthRequest, res: Response) => {
  const openCount = await prisma.livePosition.count({ where: { userId: req.userId } });
  res.json({
    running:     isLiveRunning(req.userId!),
    stopping:    isLiveStopping(req.userId!),
    openCount,
    totalTrades: await prisma.liveTradeLog.count({ where: { userId: req.userId } })
  });
});

// POST /api/live/start
router.post('/start', requireAuth, (req: AuthRequest, res: Response) => {
  if (isLiveRunning(req.userId!)) return res.json({ ok: true, message: '이미 실행 중' });
  startLiveScanner(req.userId!, broadcastFn);
  res.json({ ok: true, message: '실거래 스캐너 시작됨' });
});

// POST /api/live/stop — 중지 예정
router.post('/stop', requireAuth, (req: AuthRequest, res: Response) => {
  if (!isLiveRunning(req.userId!)) return res.json({ ok: true, message: '이미 중지됨' });
  stopLiveScanner(req.userId!, broadcastFn);
  res.json({ ok: true, message: '중지 예정으로 설정됨' });
});

// POST /api/live/force-stop — 즉시 중지
router.post('/force-stop', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!isLiveRunning(req.userId!)) return res.json({ ok: true, message: '이미 중지됨' });
  await forceStopLiveScanner(req.userId!, broadcastFn);
  res.json({ ok: true, message: '즉시 중지 완료' });
});

// GET /api/live/stats — 전체 거래 통계 (페이퍼 지갑과 동등)
router.get('/stats', requireAuth, async (req: AuthRequest, res: Response) => {
  const logs = await prisma.liveTradeLog.findMany({
    where:   { userId: req.userId },
    orderBy: { exitTime: 'asc' },
    select:  { symbol: true, strategyName: true, exitReason: true, pnlUsdt: true, exitTime: true }
  });
  const totalPnlUsdt = logs.reduce((s, t) => s + t.pnlUsdt, 0);
  const winRate      = groupedWinRate(logs);
  res.json({ totalTrades: logs.length, totalPnlUsdt, winRate });
});

// GET /api/live/positions
router.get('/positions', requireAuth, async (req: AuthRequest, res: Response) => {
  const positions = await getLivePositions(req.userId!);
  if (positions.length === 0) return res.json([]);
  try {
    const tickers  = await binance.get24hrTickers() as any[];
    const priceMap = new Map<string, number>(tickers.map((t: any) => [t.symbol, parseFloat(t.lastPrice)]));
    const enriched = positions.map(pos => {
      const currentPrice = priceMap.get(pos.symbol) ?? pos.entryPrice;
      const pnlPct  = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
      const pnlUsdt = pos.entryAmountUsdt * pnlPct / 100;
      return { ...pos, currentPrice, pnlPct, pnlUsdt };
    });
    res.json(enriched);
  } catch {
    res.json(positions.map(p => ({ ...p, currentPrice: p.entryPrice, pnlPct: 0, pnlUsdt: 0 })));
  }
});

// GET /api/live/logs
router.get('/logs', requireAuth, async (req: AuthRequest, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '50');
  res.json(await getLiveTradeLogs(req.userId!, limit));
});

// GET /api/live/scan-log
router.get('/scan-log', requireAuth, (req: AuthRequest, res: Response) => {
  res.json(getLiveLog(req.userId!));
});

// DELETE /api/live/position/:symbol — 수동 청산
router.delete('/position/:symbol', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await closeLivePositionManual(req.userId!, req.params.symbol, broadcastFn);
  if (!ok) return res.status(404).json({ error: `포지션 없음: ${req.params.symbol}` });
  res.json({ ok: true });
});

export default router;

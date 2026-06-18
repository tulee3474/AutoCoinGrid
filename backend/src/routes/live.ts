import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  startLiveScanner, stopLiveScanner, forceStopLiveScanner,
  isLiveRunning, isLiveStopping,
  getLiveLog, getLivePositions, getLiveTradeLogs, closeLivePositionManual
} from '../services/liveTrader';
import prisma from '../lib/prisma';

const router = Router();
let broadcastFn: (data: unknown) => void = () => {};

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

// GET /api/live/positions
router.get('/positions', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await getLivePositions(req.userId!));
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

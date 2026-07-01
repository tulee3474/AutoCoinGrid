import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  startLiveScanner, stopLiveScanner, forceStopLiveScanner,
  isLiveRunning, isLiveStopping,
  getLiveLog, getLivePositionsEnriched, getLiveTradeLogs, closeLivePositionManual,
  getLiveAccountInfo
} from '../services/liveTrader';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/crypto';

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

// GET /api/live/account — Binance 선물 지갑 현황
router.get('/account', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const info = await getLiveAccountInfo(req.userId!);
    res.json(info);
  } catch (e: any) {
    // 복호화 실패 시 진단 정보 함께 반환
    const apiErr = e.response?.data?.msg ?? e.message;
    let diag: Record<string, unknown> | undefined;
    if (apiErr?.includes('복호화') || apiErr?.includes('authenticate') || apiErr?.includes('state')) {
      const key = process.env.ENCRYPTION_KEY ?? '';
      let cycleOk = false; let cycleErr = '';
      try { const enc = encrypt('__t__'); cycleOk = decrypt(enc) === '__t__'; }
      catch (ce: any) { cycleErr = ce.message; }
      const user = await prisma.user.findUnique({ where: { id: req.userId } }).catch(() => null);
      const storedKey = user?.apiKey ?? null;
      let storedFmt = 'none'; let decOk = false; let decErr = '';
      if (storedKey) {
        const parts = storedKey.split(':');
        storedFmt = parts.length === 3
          ? `ok(iv=${parts[0].length} tag=${parts[1].length} enc=${parts[2].length})`
          : `bad(${parts.length} parts)`;
        try { decrypt(storedKey); decOk = true; } catch (de: any) { decErr = de.message; }
      }
      diag = { keyLen: key.length, keyValid: key.length >= 32, cycleOk, cycleErr: cycleErr || null, storedFmt, decOk, decErr: decErr || null };
    }
    res.status(500).json({ error: apiErr, diag });
  }
});

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

// GET /api/live/strategy-stats — 전략별 승률
router.get('/strategy-stats', requireAuth, async (req: AuthRequest, res: Response) => {
  const allLogs = await prisma.liveTradeLog.findMany({
    where:   { userId: req.userId },
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
  // Binance positionRisk 실데이터로 PnL 계산 — 펀딩 피까지 반영해 Binance ROE%와 정확히 일치
  res.json(await getLivePositionsEnriched(req.userId!));
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

// DELETE /api/live/logs — 거래 로그 전체 삭제
router.delete('/logs', requireAuth, async (req: AuthRequest, res: Response) => {
  await prisma.liveTradeLog.deleteMany({ where: { userId: req.userId } });
  res.json({ ok: true });
});

// DELETE /api/live/position/:symbol — 수동 청산
router.delete('/position/:symbol', requireAuth, async (req: AuthRequest, res: Response) => {
  const ok = await closeLivePositionManual(req.userId!, req.params.symbol, broadcastFn);
  if (!ok) return res.status(404).json({ error: `포지션 없음: ${req.params.symbol}` });
  res.json({ ok: true });
});

export default router;

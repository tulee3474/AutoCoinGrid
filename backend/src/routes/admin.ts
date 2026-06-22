import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { requireAdmin } from '../middleware/admin';
import { isPaperRunning, startPaperScanner, stopPaperScanner, getRunningUserIds } from '../services/autoScanner';

const router = Router();

// POST /api/admin/login  — 비밀번호로 관리자 토큰 발급
router.post('/login', (req: Request, res: Response) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) return res.status(500).json({ error: 'ADMIN_PASSWORD 미설정' });
  if (!password || password !== adminPassword) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  }

  const secret = process.env.JWT_SECRET!;
  const token  = jwt.sign({ role: 'admin' }, secret, { expiresIn: '12h' });
  res.json({ token });
});

// GET /api/admin/stats  — 전체 통계
router.get('/stats', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [userCount, strategyCount, livePositionCount, paperPositionCount] = await Promise.all([
      prisma.user.count(),
      prisma.strategy.count({ where: { enabled: true } }),
      prisma.livePosition.count(),
      prisma.paperPosition.count(),
    ]);
    res.json({ userCount, activeStrategies: strategyCount, livePositionCount, paperPositionCount });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/users  — 사용자 목록
router.get('/users', requireAdmin, async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, createdAt: true,
        apiKey: true,
        _count: {
          select: { strategies: true, livePositions: true, liveTradeLogs: true }
        },
        paperWallet: { select: { balance: true, initialBalance: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(users.map(u => ({
      id:             u.id,
      email:          u.email,
      createdAt:      u.createdAt,
      hasApiKeys:     !!u.apiKey,
      strategies:     u._count.strategies,
      livePositions:  u._count.livePositions,
      liveTrades:     u._count.liveTradeLogs,
      paperBalance:   u.paperWallet?.balance ?? null,
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/users/:userId  — 특정 사용자 상세
router.get('/users/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        strategies: true,
        livePositions: true,
        liveTradeLogs: { orderBy: { exitTime: 'desc' }, take: 50 },
        paperWallet: { include: { openPositions: true, tradeLogs: { orderBy: { exitTime: 'desc' }, take: 50 } } }
      }
    });
    if (!user) return res.status(404).json({ error: '사용자 없음' });

    const { passwordHash, apiKey, apiSecret, ...safe } = user;
    res.json({ ...safe, hasApiKeys: !!(apiKey && apiSecret) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/users/:userId  — 사용자 삭제
router.delete('/users/:userId', requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.user.delete({ where: { id: req.params.userId } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/scanners  — 실행 중인 스캐너 userId 목록
router.get('/scanners', requireAdmin, (_req: Request, res: Response) => {
  res.json({ runningUserIds: getRunningUserIds() });
});

// POST /api/admin/scanners/:userId/start  — 어드민이 특정 계정 스캐너 시작
router.post('/scanners/:userId/start', requireAdmin, (req: Request, res: Response) => {
  const { userId } = req.params;
  if (isPaperRunning(userId)) return res.json({ ok: true, message: '이미 실행 중' });
  startPaperScanner(userId, () => {}); // SSE 없이 시작 (어드민 강제 시작용)
  res.json({ ok: true, message: '스캐너 시작됨' });
});

// POST /api/admin/scanners/:userId/stop  — 어드민이 특정 계정 스캐너 중지
router.post('/scanners/:userId/stop', requireAdmin, (req: Request, res: Response) => {
  const { userId } = req.params;
  stopPaperScanner(userId);
  res.json({ ok: true, message: '스캐너 중지됨' });
});

export default router;

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { requireAdmin } from '../middleware/admin';
import { isPaperRunning, startPaperScanner, stopPaperScanner, getRunningUserIds } from '../services/autoScanner';
import { isLiveRunning, startLiveScanner, stopLiveScanner, getRunningLiveUserIds, getLiveAccountInfo } from '../services/liveTrader';
import { binance } from '../services/binance';

const noop = () => {};

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
        paperWallet: {
          select: {
            balance: true, initialBalance: true,
            openPositions: {
              select: { symbol: true, avgEntryPrice: true, entryPrice: true, totalEntryUsdt: true, entryAmountUsdt: true, leverage: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // 미실현 손익 포함 총 자산 계산용 — 전체 유저 오픈 포지션 심볼을 모아 한 번만 시세 조회
    const allSymbols = [...new Set(users.flatMap(u => u.paperWallet?.openPositions.map(p => p.symbol) ?? []))];
    const priceMap: Record<string, number> = {};
    if (allSymbols.length > 0) {
      try {
        const indices = await binance.getFuturesPremiumIndex() as any[];
        for (const m of indices) {
          if (allSymbols.includes(m.symbol)) priceMap[m.symbol] = parseFloat(m.markPrice);
        }
      } catch {}
    }

    res.json(users.map(u => {
      // wallet.balance는 오픈 포지션 증거금이 이미 차감된 "가용 현금"이라
      // 총 자산 계산 시엔 물려 있는 증거금(marginLocked)을 다시 더해줘야 함
      let paperUnrealizedPnl = 0;
      let paperMarginLocked  = 0;
      for (const p of u.paperWallet?.openPositions ?? []) {
        const avgEntry   = p.avgEntryPrice > 0 ? p.avgEntryPrice : p.entryPrice;
        const totalUsdt  = p.totalEntryUsdt  > 0 ? p.totalEntryUsdt  : p.entryAmountUsdt;
        paperMarginLocked += totalUsdt;
        const markPrice = priceMap[p.symbol];
        if (markPrice == null) continue;
        const impliedQty = totalUsdt * p.leverage / avgEntry;
        paperUnrealizedPnl += (avgEntry - markPrice) * impliedQty; // SHORT
      }
      const paperBalance = u.paperWallet?.balance ?? null;
      return {
        id:                 u.id,
        email:              u.email,
        createdAt:          u.createdAt,
        hasApiKeys:         !!u.apiKey,
        strategies:         u._count.strategies,
        livePositions:      u._count.livePositions,
        liveTrades:         u._count.liveTradeLogs,
        paperBalance,
        paperTotalAssets:   paperBalance != null ? paperBalance + paperMarginLocked + paperUnrealizedPnl : null,
      };
    }));
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
        liveTradeLogs: { orderBy: { exitTime: 'desc' }, take: 200 },
        paperWallet: { include: { openPositions: true, tradeLogs: { orderBy: { exitTime: 'desc' }, take: 200 } } }
      }
    });
    if (!user) return res.status(404).json({ error: '사용자 없음' });

    // 오픈 포지션 현재가 조회 → 미실현 PnL 계산
    const liveSymbols  = user.livePositions.map(p => p.symbol);
    const paperSymbols = user.paperWallet?.openPositions.map(p => p.symbol) ?? [];
    const symbols      = [...new Set([...liveSymbols, ...paperSymbols])];

    const priceMap: Record<string, number> = {};
    if (symbols.length > 0) {
      try {
        const indices = await binance.getFuturesPremiumIndex() as any[];
        for (const m of indices) {
          if (symbols.includes(m.symbol)) priceMap[m.symbol] = parseFloat(m.markPrice);
        }
      } catch {}
    }

    const livePositions = user.livePositions.map(p => {
      const markPrice = priceMap[p.symbol] ?? null;
      const avgEntry  = p.avgEntryPrice > 0 ? p.avgEntryPrice : p.entryPrice;
      // SHORT: 진입가 - 현재가 × 수량 (참고용 추정치 — 그리드 체결 후 실제 수량은 Binance 총 자산 값이 정확함)
      const unrealizedPnlUsdt = markPrice !== null ? (avgEntry - markPrice) * p.qty : null;
      return {
        ...p,
        tpOrderId: p.tpOrderId?.toString() ?? null,
        slOrderId: p.slOrderId?.toString() ?? null,
        markPrice,
        unrealizedPnlUsdt,
      };
    });

    const paperPositions = (user.paperWallet?.openPositions ?? []).map(p => {
      const markPrice  = priceMap[p.symbol] ?? null;
      const avgEntry   = p.avgEntryPrice > 0 ? p.avgEntryPrice : p.entryPrice;
      const totalUsdt  = p.totalEntryUsdt  > 0 ? p.totalEntryUsdt  : p.entryAmountUsdt;
      const impliedQty = totalUsdt * p.leverage / avgEntry;
      const unrealizedPnlUsdt = markPrice !== null ? (avgEntry - markPrice) * impliedQty : null;
      return { ...p, markPrice, unrealizedPnlUsdt };
    });

    // 실현 손익 합계 (보관된 거래 기록 기준)
    const liveRealizedPnl  = user.liveTradeLogs.reduce((s, t) => s + t.pnlUsdt, 0);
    const paperRealizedPnl = (user.paperWallet?.tradeLogs ?? []).reduce((s, t) => s + t.pnlUsdt, 0);
    const liveTrades       = user.liveTradeLogs.length;
    const paperTrades      = user.paperWallet?.tradeLogs.length ?? 0;

    // 실거래 총 자산은 Binance 실계좌 값이 정확함 (그리드 체결분까지 반영된 authoritative 값)
    const liveAccountBalance = (user.apiKey && user.apiSecret)
      ? await getLiveAccountInfo(user.id).catch(() => null)
      : null;

    const { passwordHash, apiKey, apiSecret, ...safe } = user;
    res.json({
      ...safe,
      hasApiKeys: !!(apiKey && apiSecret),
      livePositions,
      liveRealizedPnl,
      liveTrades,
      liveAccountBalance,
      paperWallet: user.paperWallet
        ? { ...user.paperWallet, openPositions: paperPositions, tradeLogs: undefined }
        : null,
      paperRealizedPnl,
      paperTrades,
    });
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

// GET /api/admin/scanners  — 가상/실거래 스캐너 실행 중 userId 목록
router.get('/scanners', requireAdmin, (_req: Request, res: Response) => {
  res.json({
    paperUserIds: getRunningUserIds(),
    liveUserIds:  getRunningLiveUserIds(),
  });
});

// 가상 스캐너 시작/중지
router.post('/scanners/paper/:userId/start', requireAdmin, (req: Request, res: Response) => {
  const { userId } = req.params;
  if (isPaperRunning(userId)) return res.json({ ok: true, message: '이미 실행 중' });
  startPaperScanner(userId, noop);
  res.json({ ok: true, message: '가상 스캐너 시작됨' });
});
router.post('/scanners/paper/:userId/stop', requireAdmin, (req: Request, res: Response) => {
  stopPaperScanner(req.params.userId);
  res.json({ ok: true, message: '가상 스캐너 중지됨' });
});

// 실거래 스캐너 시작/중지
router.post('/scanners/live/:userId/start', requireAdmin, (req: Request, res: Response) => {
  const { userId } = req.params;
  if (isLiveRunning(userId)) return res.json({ ok: true, message: '이미 실행 중' });
  startLiveScanner(userId, noop);
  res.json({ ok: true, message: '실거래 스캐너 시작됨' });
});
router.post('/scanners/live/:userId/stop', requireAdmin, (req: Request, res: Response) => {
  stopLiveScanner(req.params.userId, noop);
  res.json({ ok: true, message: '실거래 스캐너 중지됨' });
});

export default router;

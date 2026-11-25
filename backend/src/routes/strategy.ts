import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { computeUsdStats } from '../services/backtest';

const router = Router();

// 화면에 내려주는 필드만 (toClientShape와 일치)
const CLIENT_FIELDS = {
  id: true, name: true, enabled: true, side: true, coins: true, conditions: true, trade: true, createdAt: true,
} as const;

function toClientShape(r: any) {
  return {
    id:         r.id,
    name:       r.name,
    enabled:    r.enabled,
    side:       r.side ?? 'SHORT',
    coins:      r.coins as string[],
    conditions: r.conditions as StrategyConditions,
    trade:      r.trade as TradeConfig,
    createdAt:  r.createdAt instanceof Date ? r.createdAt.getTime() : r.createdAt
  };
}

// GET /api/strategy
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  // AI 모델(mlFilter)·학습 상태(mlData)는 큰 JSON이라 제외 — 같이 읽으면 ORDER BY 정렬 시
  // MySQL 'Out of sort memory'(1038) 에러가 나고, 목록 조회 자체가 실패함
  const rows = await prisma.strategy.findMany({
    where:   { userId: req.userId },
    orderBy: { createdAt: 'asc' },
    select:  CLIENT_FIELDS,
  });
  res.json(rows.map(toClientShape));
});

// GET /api/strategy/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId }, select: CLIENT_FIELDS });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(toClientShape(row));
});

// POST /api/strategy
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, enabled, coins, conditions, trade, side } = req.body;
  if (!name || !conditions || !trade) {
    return res.status(400).json({ error: 'name, conditions, trade 필요' });
  }
  const row = await prisma.strategy.create({
    data: { userId: req.userId!, name, enabled: enabled ?? false, side: side ?? 'SHORT', coins: coins ?? [], conditions, trade }
  });
  res.status(201).json(toClientShape(row));
});

// PUT /api/strategy/:id
router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const exists = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'not found' });

  const { name, enabled, coins, conditions, trade, side } = req.body;
  const row = await prisma.strategy.update({
    where: { id: req.params.id },
    data:  { name, enabled, coins, conditions, trade, side }
  });
  res.json(toClientShape(row));
});

// DELETE /api/strategy/:id
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const exists = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'not found' });
  await prisma.strategy.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// POST /api/strategy/:id/toggle
router.post('/:id/toggle', requireAuth, async (req: AuthRequest, res: Response) => {
  const exists = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'not found' });
  const row = await prisma.strategy.update({
    where: { id: req.params.id },
    data:  { enabled: !exists.enabled }
  });
  res.json(toClientShape(row));
});

// 백테스트(runBacktest)의 집계 공식과 완전히 동일하게 맞춰야 두 숫자를 나란히 비교하는 의미가 있음 —
// 승패는 그룹화(연속 손절 합산) 없이 거래 1건 = 1승/1패로 단순 집계
function computeAggregateStats(pnlPcts: number[]) {
  const trades = pnlPcts.length;
  const wins   = pnlPcts.filter(p => p > 0);
  const losses = pnlPcts.filter(p => p <= 0);
  const winRate = trades > 0 ? wins.length / trades : 0;
  const avgProfitPct = wins.length   > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length     : 0;
  const avgLossPct   = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const expectedValuePct = winRate * avgProfitPct - (1 - winRate) * avgLossPct;
  return { trades, winRate, avgProfitPct, avgLossPct, expectedValuePct };
}

// GET /api/strategy/:id/comparison?type=live|paper — 백테스트 예측치와 실제 거래 로그 집계 비교용
// (프론트에서 이 응답의 conditions/trade/side를 그대로 POST /api/backtest/validate에 넘겨 백테스트
// 쪽 숫자를 받고, actual과 나란히 표시 — 기존 backtest.ts/validate 로직은 전혀 건드리지 않음)
router.get('/:id/comparison', requireAuth, async (req: AuthRequest, res: Response) => {
  const strategy = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!strategy) return res.status(404).json({ error: 'not found' });

  const type = (req.query.type as string) === 'paper' ? 'paper' : 'live';

  let pnlPcts: number[];
  let actualUsd: ReturnType<typeof computeUsdStats>;   // 금액 기준 (실거래는 순손익, 가상은 가격 손익)
  // 실거래 전용: 가격 기준(펀딩피·수수료 제외) 통계와 비용 정보 — 순손익 EV와 나란히 참고용
  let liveExtra: { gross: ReturnType<typeof computeAggregateStats>; avgCostPct: number; unsyncedTrades: number } | null = null;
  if (type === 'live') {
    const logs = await prisma.liveTradeLog.findMany({
      where:  { userId: req.userId, strategyName: strategy.name },
      select: { pnlPct: true, pnlUsdt: true, entryAmountUsdt: true, fundingFee: true, commission: true, feesSynced: true }
    });
    actualUsd = computeUsdStats(logs.map(l => ({ netUsdt: l.pnlUsdt + l.fundingFee + l.commission, baseUsdt: l.entryAmountUsdt })));
    // 순손익 % = 가격 손익 % + (펀딩피+수수료)/투입 증거금. 그리드 추가진입 시 증거금이 entryAmountUsdt보다
    // 커서(로그엔 totalEntryUsdt가 없음) pnlUsdt/pnlPct로 실제 기준 증거금을 역산 — pnlPct가 0이면 1차 진입액 사용
    const costPcts = logs.map(l => {
      const basis = Math.abs(l.pnlPct) > 1e-9 ? l.pnlUsdt * 100 / l.pnlPct : l.entryAmountUsdt;
      return basis > 0 ? (l.fundingFee + l.commission) / basis * 100 : 0;
    });
    pnlPcts = logs.map((l, i) => l.pnlPct + costPcts[i]);
    liveExtra = {
      gross:          computeAggregateStats(logs.map(l => l.pnlPct)),
      avgCostPct:     costPcts.length > 0 ? costPcts.reduce((a, b) => a + b, 0) / costPcts.length : 0,
      unsyncedTrades: logs.filter(l => !l.feesSynced).length,
    };
  } else {
    const wallet = await prisma.paperWallet.findUnique({ where: { userId: req.userId! } });
    const logs = wallet
      ? await prisma.paperTradeLog.findMany({
          where:  { walletId: wallet.id, strategyName: strategy.name },
          select: { pnlPct: true, pnlUsdt: true, entryAmountUsdt: true }
        })
      : [];
    pnlPcts = logs.map(l => l.pnlPct);
    actualUsd = computeUsdStats(logs.map(l => ({ netUsdt: l.pnlUsdt, baseUsdt: l.entryAmountUsdt })));
  }

  res.json({
    ...toClientShape(strategy),
    type,
    actual: computeAggregateStats(pnlPcts),   // 실거래는 순손익(펀딩피·수수료 반영) 기준
    actualUsd,
    liveExtra
  });
});

export default router;

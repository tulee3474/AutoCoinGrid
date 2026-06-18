import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';

const router = Router();

function toClientShape(r: any) {
  return {
    id:         r.id,
    name:       r.name,
    enabled:    r.enabled,
    coins:      r.coins as string[],
    conditions: r.conditions as StrategyConditions,
    trade:      r.trade as TradeConfig,
    createdAt:  r.createdAt instanceof Date ? r.createdAt.getTime() : r.createdAt
  };
}

// GET /api/strategy
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const rows = await prisma.strategy.findMany({
    where:   { userId: req.userId },
    orderBy: { createdAt: 'asc' }
  });
  res.json(rows.map(toClientShape));
});

// GET /api/strategy/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(toClientShape(row));
});

// POST /api/strategy
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, enabled, coins, conditions, trade } = req.body;
  if (!name || !conditions || !trade) {
    return res.status(400).json({ error: 'name, conditions, trade 필요' });
  }
  const row = await prisma.strategy.create({
    data: { userId: req.userId!, name, enabled: enabled ?? false, coins: coins ?? [], conditions, trade }
  });
  res.status(201).json(toClientShape(row));
});

// PUT /api/strategy/:id
router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const exists = await prisma.strategy.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'not found' });

  const { name, enabled, coins, conditions, trade } = req.body;
  const row = await prisma.strategy.update({
    where: { id: req.params.id },
    data:  { name, enabled, coins, conditions, trade }
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

export default router;

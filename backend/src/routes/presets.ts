import { Router } from 'express';
import prisma from '../lib/prisma';
import { requireAdmin } from '../middleware/admin';

const router = Router();

// GET /api/presets — 공개, 기본 + 추천 전략 반환
router.get('/', async (_req, res) => {
  try {
    const [def, recommended] = await Promise.all([
      prisma.adminPreset.findFirst({ where: { type: 'default' } }),
      prisma.adminPreset.findMany({
        where: { type: 'recommended' },
        orderBy: { sortOrder: 'asc' }
      })
    ]);
    res.json({ default: def, recommended });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/presets — 관리자 전용: 프리셋 생성
router.post('/', requireAdmin, async (req, res) => {
  const { type, name, conditions, trade, sortOrder, side } = req.body;
  if (!type || !name || !conditions || !trade) {
    return res.status(400).json({ error: 'type, name, conditions, trade 필요' });
  }
  try {
    // 기본 전략은 하나만 존재
    if (type === 'default') {
      await prisma.adminPreset.deleteMany({ where: { type: 'default' } });
    }
    const preset = await prisma.adminPreset.create({
      data: { type, name, side: side ?? 'SHORT', conditions, trade, sortOrder: sortOrder ?? 0 }
    });
    res.json(preset);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/presets/:id — 관리자 전용: 프리셋 수정
router.put('/:id', requireAdmin, async (req, res) => {
  const { name, conditions, trade, sortOrder, side } = req.body;
  try {
    const preset = await prisma.adminPreset.update({
      where: { id: req.params.id },
      data: { name, conditions, trade, sortOrder, side }
    });
    res.json(preset);
  } catch {
    res.status(404).json({ error: '프리셋 없음' });
  }
});

// DELETE /api/presets/:id — 관리자 전용: 프리셋 삭제
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.adminPreset.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: '프리셋 없음' });
  }
});

export default router;

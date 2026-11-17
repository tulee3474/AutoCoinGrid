import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { startTraining, getJob, strategyHash, MlFilterState } from '../services/ml/trainer';
import { FEATURE_NAMES } from '../services/ml/features';

// ── AI 진입 필터 API ──────────────────────────────────────────
// 학습은 수 분 걸리는 백그라운드 작업 → POST로 시작하고 GET으로 진행 상황/결과를 폴링
const router = Router();

async function findStrategy(req: AuthRequest) {
  return prisma.strategy.findFirst({ where: { id: req.params.strategyId, userId: req.userId } });
}

// 모델 본체(트리)는 크고 화면에 불필요 → 메타/검증 결과만 내려줌
function publicState(row: any) {
  const f = row.mlFilter as MlFilterState | null;
  if (!f) return null;
  const { model: _model, ...rest } = f;
  return {
    ...rest,
    // 학습 후 전략 조건/매매 설정이 바뀌었으면 모델이 다른 전략 기준으로 학습된 것 → 재학습 권장
    stale: f.trainedFor !== strategyHash({ conditions: row.conditions, trade: row.trade, side: row.side }),
    // 서버 업데이트로 입력값 정의가 바뀌면 옛 모델은 실전에서 자동으로 꺼짐 → 재학습 필요
    outdated: f.featureNames.join(',') !== FEATURE_NAMES.join(','),
  };
}

// GET /api/ml/:strategyId — 필터 상태 + 학습 진행 상황
router.get('/:strategyId', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ filter: publicState(row), job: getJob(row.id) });
});

// POST /api/ml/:strategyId/train { days } — 학습 시작
router.post('/:strategyId/train', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  const days = Math.min(365, Math.max(60, Number(req.body?.days) || 180));
  try {
    res.json({ job: startTraining(req.userId!, row.id, days) });
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

// PATCH /api/ml/:strategyId { applyPaper?, applyLive?, threshold? } — 사용 여부/기준 확률 변경 (다음 스캔부터 즉시 반영)
router.patch('/:strategyId', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  const f = row.mlFilter as MlFilterState | null;
  if (!f) return res.status(400).json({ error: '먼저 학습하세요' });
  const next: MlFilterState = { ...f };
  if (typeof req.body?.applyPaper === 'boolean') next.applyPaper = req.body.applyPaper;
  if (typeof req.body?.applyLive  === 'boolean') next.applyLive  = req.body.applyLive;
  if (typeof req.body?.threshold === 'number') {
    if (!(req.body.threshold >= 0 && req.body.threshold <= 1)) return res.status(400).json({ error: 'threshold는 0~1' });
    next.threshold = req.body.threshold;
  }
  const updated = await prisma.strategy.update({ where: { id: row.id }, data: { mlFilter: next as any } });
  res.json({ filter: publicState(updated) });
});

// DELETE /api/ml/:strategyId — 모델 삭제 (필터 해제)
router.delete('/:strategyId', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  await prisma.strategy.update({ where: { id: row.id }, data: { mlFilter: Prisma.DbNull } });
  res.json({ ok: true });
});

export default router;

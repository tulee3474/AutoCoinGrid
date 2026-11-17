import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import prisma from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { startTraining, getJob, strategyHash, MlFilterState, MlDataState, FEATURE_VER } from '../services/ml/trainer';
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

// 저장된 학습 데이터 현황 (출처별 건수·기간) + 아직 학습 데이터로 안 넣은 실거래 건수
async function dataStatus(row: any) {
  const d = row.mlData as MlDataState | null;
  const groups = await prisma.mlSample.groupBy({
    by: ['source'], where: { strategyId: row.id },
    _count: { _all: true }, _min: { entryTime: true }, _max: { entryTime: true },
  });
  const g = (src: string) => {
    const x = groups.find(r => r.source === src);
    return { count: x?._count._all ?? 0, from: x?._min.entryTime?.getTime() ?? null, to: x?._max.entryTime?.getTime() ?? null };
  };
  const liveTrades = await prisma.liveTradeLog.count({ where: { userId: row.userId, strategyName: row.name, feesSynced: true } });
  return {
    state: d,
    backtest: g('backtest'),
    live: g('live'),
    liveTradesAvailable: liveTrades,
    configChanged: !!d && d.configHash !== strategyHash({ conditions: row.conditions, trade: row.trade, side: row.side }),
  };
}

// GET /api/ml/:strategyId — 필터 상태 + 학습 데이터 현황 + 학습 진행 상황
router.get('/:strategyId', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ filter: publicState(row), data: await dataStatus(row), job: getJob(row.id) });
});

// POST /api/ml/:strategyId/train { days, reset, includeLive, liveWeight } — 학습 시작
// 저장된 데이터가 있으면 마지막 수집 이후분만 추가 수집 후 누적 전체로 학습 (reset=true면 처음부터)
router.post('/:strategyId/train', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  const days = Math.min(365, Math.max(60, Number(req.body?.days) || 180));
  const liveWeight = Math.min(5, Math.max(1, Number(req.body?.liveWeight) || 2));
  try {
    res.json({ job: startTraining(req.userId!, row.id, {
      days, reset: req.body?.reset === true, includeLive: req.body?.includeLive !== false, liveWeight, mode: 'manual',
    }) });
  } catch (e: any) {
    res.status(409).json({ error: e.message });
  }
});

// GET /api/ml/:strategyId/samples.csv — 저장된 학습 데이터 내려받기 (분석용)
router.get('/:strategyId/samples.csv', requireAuth, async (req: AuthRequest, res: Response) => {
  const row = await findStrategy(req);
  if (!row) return res.status(404).json({ error: 'not found' });
  const rows = await prisma.mlSample.findMany({ where: { strategyId: row.id }, orderBy: { entryTime: 'asc' } });
  const head = ['source', 'symbol', 'entry_time', 'exit_time', 'net_pnl_pct', 'gross_pnl_pct', 'label', 'current_config', 'current_features', ...FEATURE_NAMES];
  const hash = strategyHash({ conditions: row.conditions, trade: row.trade, side: row.side });
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.source, r.symbol, r.entryTime.toISOString(), r.exitTime.toISOString(),
      r.netPnlPct.toFixed(4), r.grossPnlPct.toFixed(4), r.netPnlPct > 0 ? 1 : 0,
      r.source === 'live' || r.configHash === hash ? 1 : 0,
      r.featureVer === FEATURE_VER ? 1 : 0,
      ...(r.features as number[]).map(v => +v.toFixed(6)),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ml_samples_${row.id.slice(0, 8)}.csv"`);
  res.send(lines.join('\n'));
});

// PATCH /api/ml/:strategyId { applyPaper?, applyLive?, threshold?, autoUpdate? } — 사용 여부/기준 확률 변경 (다음 스캔부터 즉시 반영)
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
  const data: any = {};
  if (typeof req.body?.autoUpdate === 'boolean') {
    const d = row.mlData as MlDataState | null;
    if (!d) return res.status(400).json({ error: '먼저 학습하세요' });
    // 켜는 시점을 기준으로 주기 계산 (켜자마자 바로 돌지 않게)
    data.mlData = { ...d, autoUpdate: req.body.autoUpdate, lastAuto: d.lastAuto ?? { at: Date.now(), ok: true, message: '자동 업데이트 켬' } };
  }
  const updated = await prisma.strategy.update({ where: { id: row.id }, data: { mlFilter: next as any, ...data } });
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

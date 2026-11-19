import prisma from '../../lib/prisma';
import { binance } from '../binance';
import { simulateEntryAt } from '../backtest';
import { TradeConfig, Side } from '../../types';
import { auc } from './gbdt';
import { liveNetPct } from './liveNet';

// ── AI 판정 사후 평가 ──────────────────────────────────────────
// 판정(통과/차단) 시각·가격에 진입했다고 가정하고, 판정 당시 매매 설정으로 백테스트와 같은 규칙으로 시뮬레이션.
// 결과가 확정(TP/SL/시간 만료)되면 good(좋은 거래였나)과 correct(AI가 맞았나)를 기록.
//   · 차단 판정: 실제로 나쁜 거래였으면 맞음 (손실 회피)  / 좋은 거래였으면 틀림 (수익 놓침)
//   · 통과 판정: 좋은 거래였으면 맞음 / 나쁜 거래였으면 틀림
// '좋은 거래' 기준은 그 모델의 학습 목표와 같음 (avoidLoss: 큰 손실이 아님 / profit: 순손익 > 0)

const H = 3_600_000;
const MINS: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
const GIVE_UP_MS = 30 * 24 * H;   // 30일이 지나도 결과가 안 나오면(시간 만료 없는 전략 등) 미확정 처리

export function isGood(mlTarget: string, netPnlPct: number, lossCutPct: number | null): boolean {
  return mlTarget === 'avoidLoss' ? netPnlPct > -(lossCutPct ?? 0) : netPnlPct > 0;
}

export async function evaluatePendingDecisions(limit = 100): Promise<{ done: number; unresolved: number; pending: number }> {
  const now = Date.now();
  // 큰 JSON(features)은 제외하고 조회 — 정렬 메모리 문제 방지
  const rows = await prisma.mlDecision.findMany({
    where: { evalStatus: 'pending', skipReason: null, decidedAt: { lte: new Date(now - 2 * H) } },
    orderBy: { decidedAt: 'asc' },
    take: limit,
    select: {
      id: true, symbol: true, side: true, decidedAt: true, price: true, pass: true,
      mlTarget: true, lossCutPct: true, interval: true, trade: true,
    },
  });
  let done = 0, unresolved = 0, pending = 0;
  for (const d of rows) {
    const t0 = d.decidedAt.getTime();
    const ivMs = (MINS[d.interval] ?? 60) * 60_000;
    const giveUp = async () => {
      if (now - t0 < GIVE_UP_MS) { pending++; return; }
      await prisma.mlDecision.update({ where: { id: d.id }, data: { evalStatus: 'unresolved', evalAt: new Date() } });
      unresolved++;
    };
    try {
      const klines = await binance.getFuturesKlinesRange(d.symbol, d.interval, t0 - 2 * ivMs);
      if (klines.length < 3) { await giveUp(); continue; }
      const funding = await binance.getFundingRateHistory(d.symbol, t0 - 8 * H, true);
      const r = await simulateEntryAt(klines, t0, d.price, d.trade as unknown as TradeConfig, d.interval, d.side as Side, d.symbol, funding);
      // 결과 미확정: 아직 진행 중(데이터 끝 캔들에서 끊김) — 다음 평가 때 다시
      if (!r || (r.exitReason === 'timeout' && r.exitTime >= klines[klines.length - 1].openTime)) { await giveUp(); continue; }
      const good = isGood(d.mlTarget, r.netPnlPct, d.lossCutPct);
      await prisma.mlDecision.update({
        where: { id: d.id },
        data: {
          evalStatus: 'done', evalAt: new Date(),
          simExitPrice: r.exitPrice, simExitTime: new Date(r.exitTime), simExitReason: r.exitReason, simGrids: r.gridsFilled,
          simNetPnlPct: r.netPnlPct, simGrossPnlPct: r.pnlPct,
          good, correct: d.pass ? good : !good,
        },
      });
      done++;
    } catch (e: any) {
      console.warn(`[ml] 판정 평가 ${d.symbol} 실패: ${e.message}`);   // 상장폐지 등 — 30일 뒤 미확정 처리
      await giveUp().catch(() => {});
    }
  }
  return { done, unresolved, pending };
}

// ── 화면/CSV용 요약 ───────────────────────────────────────────
export interface DecisionGroupStats {
  total: number;
  evaluated: number;
  correct: number;          // AI가 맞은 건수
  goodCount: number;        // 결과가 좋은 거래였던 건수
  sumNetPct: number;        // 진입했다면 순손익 % 합 (평가 완료분)
  avgNetPct: number;
}
export interface DecisionSummary {
  total: number;
  pending: number;
  unresolved: number;
  blocked: DecisionGroupStats;
  passed: DecisionGroupStats;
  // AI 효과 = 차단으로 피한 순손익 합의 부호 반대 (양수 = 차단 덕분에 이득, 음수 = 차단 때문에 놓친 수익이 더 큼)
  aiEffectSumPct: number;
  auc: number | null;       // 평가 완료분의 AI 점수 vs 실제 결과 (학습 때의 AUC와 같은 의미)
}

export function summarizeDecisions(rows: { pass: boolean; evalStatus: string; correct: boolean | null; good: boolean | null; simNetPnlPct: number | null; prob: number }[]): DecisionSummary {
  const group = (pass: boolean): DecisionGroupStats => {
    const g = rows.filter(r => r.pass === pass);
    const ev = g.filter(r => r.evalStatus === 'done');
    const sum = ev.reduce((a, r) => a + (r.simNetPnlPct ?? 0), 0);
    return {
      total: g.length, evaluated: ev.length,
      correct: ev.filter(r => r.correct).length,
      goodCount: ev.filter(r => r.good).length,
      sumNetPct: sum, avgNetPct: ev.length ? sum / ev.length : 0,
    };
  };
  const blocked = group(false), passed = group(true);
  const ev = rows.filter(r => r.evalStatus === 'done');
  const y = ev.map(r => (r.good ? 1 : 0));
  const hasBoth = y.some(v => v === 1) && y.some(v => v === 0);
  return {
    total: rows.length,
    pending: rows.filter(r => r.evalStatus === 'pending').length,
    unresolved: rows.filter(r => r.evalStatus === 'unresolved').length,
    blocked, passed,
    aiEffectSumPct: -blocked.sumNetPct,
    auc: ev.length >= 10 && hasBoth ? +auc(ev.map(r => r.prob), y).toFixed(3) : null,
  };
}

// ── 이전 버전 기록 정리: 같은 코인을 이미 보유 중일 때 나온 판정 (어차피 진입 안 했던 신호) ─────────
// 수정 전에는 진입 가능 여부 확인 전에 AI를 돌려, 보유 중에도 4시간마다 판정이 쌓였음 → 한 거래가 통계에 여러 번 잡힘.
// 판정 시각에 같은 코인·방향 포지션이 이미 열려 있었으면 skipReason='holding'으로 표시해 통계·학습·평가에서 제외
export async function markHoldingDecisions(): Promise<number> {
  const rows = await prisma.mlDecision.findMany({
    where: { skipReason: null },
    select: { id: true, userId: true, target: true, symbol: true, side: true, decidedAt: true },
  });
  const wallets = new Map<string, string | null>();
  let marked = 0;
  for (const d of rows) {
    const before = new Date(d.decidedAt.getTime() - 60_000);   // 이 판정 직후 진입한 포지션은 제외 (판정 1분 전 이전에 열린 것만)
    let holding = false;
    if (d.target === 'live') {
      holding = !!(await prisma.liveTradeLog.findFirst({ where: { userId: d.userId, symbol: d.symbol, side: d.side, entryTime: { lte: before }, exitTime: { gt: d.decidedAt } }, select: { id: true } }))
        || !!(await prisma.livePosition.findFirst({ where: { userId: d.userId, symbol: d.symbol, side: d.side, openedAt: { lte: before } }, select: { id: true } }));
    } else {
      if (!wallets.has(d.userId)) wallets.set(d.userId, (await prisma.paperWallet.findUnique({ where: { userId: d.userId }, select: { id: true } }))?.id ?? null);
      const walletId = wallets.get(d.userId);
      if (!walletId) continue;
      holding = !!(await prisma.paperTradeLog.findFirst({ where: { walletId, symbol: d.symbol, side: d.side, entryTime: { lte: before }, exitTime: { gt: d.decidedAt } }, select: { id: true } }))
        || !!(await prisma.paperPosition.findFirst({ where: { walletId, symbol: d.symbol, side: d.side, openedAt: { lte: before } }, select: { id: true } }));
    }
    if (holding) {
      await prisma.mlDecision.update({ where: { id: d.id }, data: { skipReason: 'holding' } });
      marked++;
    }
  }
  return marked;
}

// ── 판정 직후 실제로 진입했는지 (사람이 확인용) ─────────────────────
// 통과 판정 후 5분 안에 같은 코인·방향으로 열린 포지션(청산됐으면 거래 기록, 아니면 보유 중 포지션)
export interface ActualEntry { status: 'open' | 'closed'; entryPrice: number; netPnlPct: number | null; exitReason: string | null }
export async function findActualEntries(
  userId: string, rows: { id: string; target: string; symbol: string; side: string; decidedAt: Date; pass: boolean }[]
): Promise<Map<string, ActualEntry>> {
  const out = new Map<string, ActualEntry>();
  const passRows = rows.filter(r => r.pass);
  if (passRows.length === 0) return out;
  const minT = new Date(Math.min(...passRows.map(r => r.decidedAt.getTime())) - 60_000);
  const symbols = [...new Set(passRows.map(r => r.symbol))];
  const wallet = await prisma.paperWallet.findUnique({ where: { userId }, select: { id: true } });
  const [liveLogs, livePos, paperLogs, paperPos] = await Promise.all([
    prisma.liveTradeLog.findMany({ where: { userId, symbol: { in: symbols }, entryTime: { gte: minT } } }),
    prisma.livePosition.findMany({ where: { userId, symbol: { in: symbols }, openedAt: { gte: minT } } }),
    wallet ? prisma.paperTradeLog.findMany({ where: { walletId: wallet.id, symbol: { in: symbols }, entryTime: { gte: minT } } }) : Promise.resolve([]),
    wallet ? prisma.paperPosition.findMany({ where: { walletId: wallet.id, symbol: { in: symbols }, openedAt: { gte: minT } } }) : Promise.resolve([]),
  ]);
  const within = (t: Date, d: Date) => t.getTime() >= d.getTime() - 60_000 && t.getTime() <= d.getTime() + 5 * 60_000;
  for (const r of passRows) {
    const same = (x: { symbol: string; side: string }) => x.symbol === r.symbol && x.side === r.side;
    if (r.target === 'live') {
      const l = liveLogs.find(x => same(x) && within(x.entryTime, r.decidedAt));
      if (l) { out.set(r.id, { status: 'closed', entryPrice: l.entryPrice, netPnlPct: liveNetPct(l), exitReason: l.exitReason }); continue; }
      const p = livePos.find(x => same(x) && within(x.openedAt, r.decidedAt));
      if (p) out.set(r.id, { status: 'open', entryPrice: p.entryPrice, netPnlPct: null, exitReason: null });
    } else {
      const l = paperLogs.find(x => same(x) && within(x.entryTime, r.decidedAt));
      if (l) { out.set(r.id, { status: 'closed', entryPrice: l.entryPrice, netPnlPct: l.pnlPct, exitReason: l.exitReason }); continue; }
      const p = paperPos.find(x => same(x) && within(x.openedAt, r.decidedAt));
      if (p) out.set(r.id, { status: 'open', entryPrice: p.entryPrice, netPnlPct: null, exitReason: null });
    }
  }
  return out;
}

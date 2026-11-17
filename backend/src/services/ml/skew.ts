import prisma from '../../lib/prisma';
import { FEATURE_NAMES, FEATURE_LABELS } from './features';
import { FEATURE_VER } from './version';

// ── 학습–실전 입력값 차이 점검 (training/serving skew) ─────────────────
// 같은 신호에 대해 "실전에서 AI가 본 값(판정 기록)"과 "학습 데이터가 가진 값(백테스트 표본, 나중에 과거 캔들로 계산)"을 짝지어 비교.
// 차이가 큰 지표는 모델이 학습 때와 다른 값을 보고 판단하고 있다는 뜻 → 실전 성능이 검증 성능보다 나쁜 원인 후보.
// 짝이 안 맞는 판정(백테스트에는 같은 신호가 없음) 비율도 함께 — 실시간 스캐너와 백테스트가 신호를 다르게 잡는지

const MINS: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

export interface SkewFeature {
  name: string;
  label: string;
  pairs: number;            // 두 값이 모두 있는 짝 수
  meanLive: number;         // 실전 값 평균
  meanTrain: number;        // 학습 데이터 값 평균
  meanAbsDiff: number;      // |실전 − 학습| 평균
  stdDiff: number;          // 평균 차이 / 학습 데이터 전체 표준편차 — 0.5 이상이면 '큰 차이'
  corr: number | null;      // 짝지은 값 상관계수 — 1에 가까울수록 같은 값
  missingLive: number;      // 실전에서만 결측인 짝 수
  missingTrain: number;     // 학습 데이터에서만 결측인 짝 수
}

export interface SkewReport {
  decisions: number;        // 현재 설정·입력값 정의로 기록된 판정 수
  comparable: number;       // 백테스트 수집이 끝난 구간의 판정 (짝을 찾을 수 있는 것)
  matched: number;          // 같은 신호의 백테스트 표본을 찾은 판정
  features: SkewFeature[];  // 차이 큰 순
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export async function computeSkew(strategyId: string, configHash: string, interval: string, collectedUntil: number): Promise<SkewReport> {
  const win = Math.max(2 * 3_600_000, 2 * (MINS[interval] ?? 60) * 60_000);
  const [decs, bts] = await Promise.all([
    prisma.mlDecision.findMany({
      where: { strategyId, featureVer: FEATURE_VER, configHash },
      select: { symbol: true, decidedAt: true, features: true },
    }),
    prisma.mlSample.findMany({
      where: { strategyId, source: 'backtest', featureVer: FEATURE_VER, configHash },
      select: { symbol: true, entryTime: true, features: true },
    }),
  ]);

  const btBySym = new Map<string, { t: number; x: (number | null)[] }[]>();
  for (const b of bts) (btBySym.get(b.symbol) ?? btBySym.set(b.symbol, []).get(b.symbol)!).push({ t: b.entryTime.getTime(), x: b.features as (number | null)[] });

  const comparable = decs.filter(d => d.decidedAt.getTime() <= collectedUntil - win);
  const pairs: { live: (number | null)[]; train: (number | null)[] }[] = [];
  for (const d of comparable) {
    const t = d.decidedAt.getTime();
    let best: { t: number; x: (number | null)[] } | null = null;
    for (const b of btBySym.get(d.symbol) ?? []) {
      if (Math.abs(b.t - t) <= win && (!best || Math.abs(b.t - t) < Math.abs(best.t - t))) best = b;
    }
    if (best) pairs.push({ live: d.features as (number | null)[], train: best.x });
  }

  const features: SkewFeature[] = FEATURE_NAMES.map((name, f) => {
    // 학습 데이터 전체의 표준편차 (차이 크기를 지표 단위와 무관하게 비교하기 위해)
    const all = bts.map(b => (b.features as (number | null)[])[f]).filter(finite);
    const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
    const std = all.length > 1 ? Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / (all.length - 1)) : 0;

    const both = pairs.filter(p => finite(p.live[f]) && finite(p.train[f]));
    const L = both.map(p => p.live[f] as number), T = both.map(p => p.train[f] as number);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const mL = avg(L), mT = avg(T);
    const mad = avg(L.map((v, i) => Math.abs(v - T[i])));
    let corr: number | null = null;
    if (both.length >= 5) {
      const sl = Math.sqrt(avg(L.map(v => (v - mL) ** 2))), st = Math.sqrt(avg(T.map(v => (v - mT) ** 2)));
      corr = sl > 0 && st > 0 ? +(avg(L.map((v, i) => (v - mL) * (T[i] - mT))) / (sl * st)).toFixed(3) : null;
    }
    return {
      name, label: FEATURE_LABELS[name] ?? name, pairs: both.length,
      meanLive: mL, meanTrain: mT, meanAbsDiff: mad,
      stdDiff: std > 0 ? +(mad / std).toFixed(3) : 0,
      corr,
      missingLive: pairs.filter(p => !finite(p.live[f]) && finite(p.train[f])).length,
      missingTrain: pairs.filter(p => finite(p.live[f]) && !finite(p.train[f])).length,
    };
  }).sort((a, b) => b.stdDiff - a.stdDiff);

  return { decisions: decs.length, comparable: comparable.length, matched: pairs.length, features };
}

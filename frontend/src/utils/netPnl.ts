import { PnlStats } from '../types';

// 백테스트/전략 검증 결과에서 순손익(펀딩피·수수료 반영) 통계를 꺼냄.
// 이전 버전 서버 응답이나 스토어에 남은 옛 결과엔 net이 없으므로 가격 기준 값으로 폴백
export function netStatsOf(r: {
  winRate: number; avgProfitPct: number; avgLossPct: number; expectedValuePct: number; net?: PnlStats;
}): PnlStats & { isNet: boolean } {
  if (r.net) return { ...r.net, isNet: true };
  return { winRate: r.winRate, avgProfitPct: r.avgProfitPct, avgLossPct: r.avgLossPct, expectedValuePct: r.expectedValuePct, isNet: false };
}

export const fmtSignedPct = (v: number, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;

// "가격 기준 EV +x% · 수수료 -y% · 펀딩 -z% (펀딩 미반영 n건)" 한 줄 요약
export function costSummary(r: {
  expectedValuePct: number; avgCommissionPct?: number; avgFundingPct?: number; fundingMissingTrades?: number;
}): string | null {
  if (r.avgCommissionPct === undefined) return null;
  const parts = [
    `가격 기준 EV ${fmtSignedPct(r.expectedValuePct)}`,
    `거래당 수수료 ${fmtSignedPct(r.avgCommissionPct)}`,
    `펀딩 ${fmtSignedPct(r.avgFundingPct ?? 0)}`,
  ];
  const missing = r.fundingMissingTrades ?? 0;
  return parts.join(' · ') + (missing > 0 ? ` (펀딩 미반영 ${missing}건)` : '');
}

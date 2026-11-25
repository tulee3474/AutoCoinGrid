import { binance, FundingRateRow } from './binance';
import { StrategyConditions, Side } from '../types';

// ── 펀딩 비용 필터 ────────────────────────────────────────────
// "하루 펀딩 비용(명목가치 대비 %)"이 전략의 상한(maxFundingCostPerDay)보다 크면 진입하지 않음.
// 정산 간격이 코인마다 달라(1h/4h/8h) 정산 1회 펀딩비로 비교하면 1시간 간격 코인이 과소평가됨 → 하루치로 환산.
//   숏: 펀딩비가 마이너스면 숏이 냄(비용) / 롱: 플러스면 롱이 냄(비용)
// 기준 펀딩비 = 시각 T 이전의 마지막 "정산된" 펀딩비 — 실거래 스캐너·백테스트·과거 거래 점검이 모두 같은 값을 씀
// (예상 펀딩비는 과거 이력이 없어 백테스트와 맞출 수 없음)

export interface FundingCost {
  ratePct: number;        // 직전 정산 펀딩비 (%)
  intervalH: number;      // 정산 간격 (시간)
  costPerDayPct: number;  // 하루 펀딩 비용 (명목가치 대비 %, 양수 = 내야 함, 음수 = 받음)
  at: number;             // 기준 정산 시각
}

export function fundingCostAt(rows: FundingRateRow[] | null, T: number, side: Side): FundingCost | null {
  if (!rows || rows.length === 0) return null;
  let idx = -1;
  for (let i = 0; i < rows.length; i++) { if (rows[i].fundingTime <= T) idx = i; else break; }
  if (idx < 0) return null;
  const gapH = idx > 0 ? Math.round((rows[idx].fundingTime - rows[idx - 1].fundingTime) / 3_600_000) : 8;
  const intervalH = Math.min(8, Math.max(1, gapH || 8));
  const ratePct = rows[idx].fundingRate * 100;
  const costPerDayPct = (side === 'SHORT' ? -ratePct : ratePct) * (24 / intervalH);
  return { ratePct, intervalH, costPerDayPct, at: rows[idx].fundingTime };
}

export const fundingFilterOn = (c: StrategyConditions) => c.maxFundingCostPerDay != null;

export function fundingBlocked(c: StrategyConditions, cost: FundingCost | null): boolean {
  return c.maxFundingCostPerDay != null && cost !== null && cost.costPerDayPct > c.maxFundingCostPerDay;
}

// 실시간 스캐너용: 지금 기준 판정. 펀딩 이력 조회 실패 시 막지 않음(필터 없이 진행)
export async function checkFundingNow(c: StrategyConditions, side: Side, symbol: string): Promise<{ blocked: boolean; cost: FundingCost | null }> {
  if (!fundingFilterOn(c)) return { blocked: false, cost: null };
  const now = Date.now();
  const rows = await binance.getFundingRateHistory(symbol, now - 3 * 86_400_000).catch(() => null);
  const cost = fundingCostAt(rows, now, side);
  return { blocked: fundingBlocked(c, cost), cost };
}

// 같은 코인 차단 로그가 매분 반복되지 않도록 (사용자·전략·코인당 1시간에 1번)
const lastLogged = new Map<string, number>();
export function shouldLogFundingBlock(key: string): boolean {
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) < 3_600_000) return false;
  lastLogged.set(key, now);
  if (lastLogged.size > 5000) for (const [k, t] of lastLogged) if (now - t > 3_600_000) lastLogged.delete(k);
  return true;
}

export const fmtFundingCost = (c: FundingCost) =>
  `하루 펀딩 비용 ${c.costPerDayPct.toFixed(2)}% (정산 ${c.ratePct.toFixed(4)}% × ${24 / c.intervalH}회/일)`;

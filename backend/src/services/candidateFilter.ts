// 거래량 상위 N% 코인만 후보로 쓰는 공통 함수 — 스캐너(실거래/가상)와 승률 검증(/validate)이
// 같은 함수를 써야 검증 통계가 실제 진입 대상과 일치함
// null/undefined(기존 전략 필드 없음)·100 = 전체 사용 (기존 동작 그대로)
export function selectTopVolume<T extends { quoteVolume: string }>(
  items: T[],
  topPct?: number | null
): T[] {
  const pct = topPct == null ? 100 : Math.min(100, Math.max(1, topPct));
  if (pct >= 100 || items.length === 0) return items;
  const keep = Math.max(1, Math.ceil(items.length * pct / 100));
  return [...items]
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, keep);
}

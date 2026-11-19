// 실거래 기록의 순손익 % (증거금 대비) — 비교 화면(routes/strategy.ts)과 같은 계산
export function liveNetPct(l: { pnlPct: number; pnlUsdt: number; entryAmountUsdt: number; fundingFee: number; commission: number }): number {
  const basis = Math.abs(l.pnlPct) > 1e-9 ? l.pnlUsdt * 100 / l.pnlPct : l.entryAmountUsdt;
  return basis > 0 ? (l.pnlUsdt + l.fundingFee + l.commission) / basis * 100 : 0;
}

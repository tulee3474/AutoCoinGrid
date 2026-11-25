import { UsdStats } from '../types';

// 금액 기준 한 줄 요약 — % EV는 거래마다 증거금이 달라(그리드 체결 시 2~3배) 손절 손실의 무게를 과소평가하므로 같이 표시
const usd = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

export default function UsdLine({ stats, pctEv, label = '금액 기준' }: { stats?: UsdStats; pctEv?: number; label?: string }) {
  if (!stats || stats.trades === 0) return null;
  // % EV보다 금액 기준 EV가 확연히 낮으면 경고 (그리드가 찬 뒤 손절된 거래가 손익을 갉아먹는 중)
  const gap = pctEv !== undefined && pctEv - stats.evOnBasePct > Math.max(1, Math.abs(pctEv) * 0.3);
  return (
    <p className={`text-xs ${gap ? 'text-warn' : 'text-gray-400'}`}>
      {label}: 거래당 평균 <span className="font-semibold">{usd(stats.avgUsdt)}</span>
      {' · '}EV(진입금 대비) <span className="font-semibold">{pct(stats.evOnBasePct)}</span>
      {' · '}합계 {usd(stats.totalUsdt)} ({stats.trades}건)
      {gap && <> — % EV({pct(pctEv!)})보다 낮음: 그리드가 찬 뒤 손절된 거래는 증거금이 2~3배라 손실 금액이 큼</>}
    </p>
  );
}

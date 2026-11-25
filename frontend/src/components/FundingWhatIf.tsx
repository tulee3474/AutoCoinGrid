import { useState, useMemo } from 'react';
import { getFundingWhatIf, FundingWhatIfTrade } from '../utils/api';
import { fmtDateTime } from '../utils/datetime';

// 펀딩 비용 필터 사후 점검 — "이 상한을 그때 걸어뒀다면 어떤 거래가 걸러졌고, 그 거래들은 실제로 어떻게 끝났나"
// 거래별 펀딩 비용은 서버가 한 번 계산하고, 상한값을 바꿔보는 계산은 화면에서 즉시
const usd = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
const EXIT: Record<string, string> = { takeProfit: '익절', stopLoss: '손절', timeout: '시간 만료', manual: '수동', rsiExit: 'RSI 청산' };

export default function FundingWhatIf({ strategyId, limit }: { strategyId: string; limit: number }) {
  const [source, setSource] = useState<'live' | 'paper'>('live');
  const [days, setDays] = useState(90);
  const [trades, setTrades] = useState<FundingWhatIfTrade[] | null>(null);
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setBusy(true); setError('');
    try {
      const r = await getFundingWhatIf(strategyId, source, days);
      setTrades(r.trades); setFailed(r.symbolsFailed);
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  const calc = (lim: number) => {
    const all = trades ?? [];
    const blocked = all.filter(t => t.costPerDayPct !== null && t.costPerDayPct > lim);
    const kept = all.filter(t => !blocked.includes(t));
    const sum = (xs: FundingWhatIfTrade[]) => xs.reduce((a, t) => a + t.netUsdt, 0);
    const ev = (xs: FundingWhatIfTrade[]) => (xs.length ? xs.reduce((a, t) => a + t.netPct, 0) / xs.length : 0);
    return { all, blocked, kept, sumAll: sum(all), sumBlocked: sum(blocked), sumKept: sum(kept), evAll: ev(all), evKept: ev(kept) };
  };
  const r = useMemo(() => calc(limit), [trades, limit]);
  const sens = useMemo(() => [0.5, 1, 2, 3, 5, 10].map(l => ({ l, ...calc(l) })), [trades]);

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gray-300 font-medium">과거 거래로 효과 보기</span>
        <select value={source} onChange={e => { setSource(e.target.value as any); setTrades(null); }} className="input py-0.5 text-xs">
          <option value="live">실제 거래</option>
          <option value="paper">가상 지갑</option>
        </select>
        <select value={days} onChange={e => { setDays(+e.target.value); setTrades(null); }} className="input py-0.5 text-xs">
          {[30, 90, 180, 365].map(d => <option key={d} value={d}>최근 {d}일</option>)}
        </select>
        <button onClick={load} disabled={busy}
          className="px-2.5 py-1 rounded-md border border-accent/30 text-accent hover:bg-accent/10 disabled:opacity-40">
          {busy ? '계산 중... (코인 수에 따라 1~3분)' : trades ? '다시 계산' : '계산'}
        </button>
      </div>
      <p className="text-gray-600">
        이 전략의 과거 거래마다 진입 시각의 펀딩비를 바이낸스 이력으로 다시 계산해, 지금 입력한 상한이었다면 걸러졌을 거래를 보여줍니다.
        {source === 'paper' && ' 가상 지갑 기록은 펀딩·수수료가 빠진 가격 손익 기준입니다.'}
      </p>
      {error && <p className="text-down">{error}</p>}

      {trades && (
        trades.length === 0 ? <p className="text-gray-500">기간 안에 이 전략의 거래가 없습니다.</p> : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="bg-surface rounded-md p-2">
                <div className="text-gray-500">전체 {r.all.length}건</div>
                <div className="text-gray-200 mt-0.5">{usd(r.sumAll)} · EV {r.evAll.toFixed(2)}%</div>
              </div>
              <div className="bg-surface rounded-md p-2">
                <div className="text-gray-500">걸러졌을 거래 {r.blocked.length}건</div>
                <div className={`mt-0.5 ${r.sumBlocked <= 0 ? 'text-up' : 'text-down'}`}>그 거래들 합계 {usd(r.sumBlocked)}</div>
              </div>
              <div className="bg-surface rounded-md p-2">
                <div className="text-gray-500">필터 적용 시 {r.kept.length}건</div>
                <div className="mt-0.5">
                  <span className={r.sumKept >= r.sumAll ? 'text-up' : 'text-down'}>{usd(r.sumKept)}</span>
                  <span className="text-gray-500"> · EV {r.evKept.toFixed(2)}% ({r.sumKept >= r.sumAll ? '+' : ''}{(r.sumKept - r.sumAll).toFixed(2)}$)</span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-gray-500 border-b border-border text-left">
                    <th className="py-1 pr-3 font-medium">상한 (%/일)</th>
                    {sens.map(s => <th key={s.l} className={`py-1 pr-3 font-medium num ${s.l === limit ? 'text-accent' : ''}`}>{s.l}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border/40">
                    <td className="py-1 pr-3 text-gray-500">걸러짐</td>
                    {sens.map(s => <td key={s.l} className="py-1 pr-3 num text-gray-300">{s.blocked.length}건</td>)}
                  </tr>
                  <tr>
                    <td className="py-1 pr-3 text-gray-500">손익 변화</td>
                    {sens.map(s => {
                      const d = s.sumKept - s.sumAll;
                      return <td key={s.l} className={`py-1 pr-3 num ${d >= 0 ? 'text-up' : 'text-down'}`}>{d >= 0 ? '+' : ''}{d.toFixed(1)}$</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>

            {r.blocked.length > 0 && (
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-gray-500 border-b border-border text-left">
                      <th className="py-1 pr-3 font-medium">진입 시각</th>
                      <th className="py-1 pr-3 font-medium">코인</th>
                      <th className="py-1 pr-3 font-medium">진입 시 펀딩</th>
                      <th className="py-1 pr-3 font-medium">하루 비용</th>
                      <th className="py-1 pr-3 font-medium">결과</th>
                      <th className="py-1 pr-3 font-medium">순손익</th>
                      <th className="py-1 font-medium">실제 펀딩</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.blocked.map((t, i) => (
                      <tr key={i} className="border-b border-border/40">
                        <td className="py-1 pr-3 text-gray-400 whitespace-nowrap">{fmtDateTime(t.entryTime)}</td>
                        <td className="py-1 pr-3 text-gray-200">{t.symbol.replace('USDT', '')}</td>
                        <td className="py-1 pr-3 num text-gray-400">{t.ratePct!.toFixed(4)}% / {t.intervalH}h</td>
                        <td className="py-1 pr-3 num text-warn">{t.costPerDayPct!.toFixed(2)}%</td>
                        <td className="py-1 pr-3 text-gray-400">{EXIT[t.exitReason] ?? t.exitReason}</td>
                        <td className={`py-1 pr-3 num ${t.netUsdt >= 0 ? 'text-up' : 'text-down'}`}>{usd(t.netUsdt)}</td>
                        <td className="py-1 num text-gray-400">{t.fundingUsdt === null ? '-' : usd(t.fundingUsdt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-gray-600">
              "그 거래들 합계"가 마이너스면 필터가 손실 거래를 막아준 것, 플러스면 수익 거래를 놓친 것입니다.
              {trades.filter(t => t.costPerDayPct === null).length > 0 && ` 펀딩 이력을 못 찾은 거래 ${trades.filter(t => t.costPerDayPct === null).length}건은 걸러지지 않는 것으로 계산.`}
              {failed > 0 && ` (펀딩 이력 조회 실패 코인 ${failed}개)`}
            </p>
          </>
        )
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { getMlDecisions, evaluateMlDecisions, downloadMlDecisions, MlDecisionRow, MlDecisionSummary } from '../utils/api';
import { fmtDateTime } from '../utils/datetime';

// AI 판정 기록 — 차단/통과한 신호를 "그때 진입했다면?"으로 사후 시뮬레이션해 AI가 맞았는지 보여줌
// (자동 평가는 서버가 1시간마다. 여기서는 사람이 눈으로 확인 + 요약 수치)

const pct = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;
const price = (v: number | null) => (v === null ? '-' : v.toPrecision(5));
const EXIT_LABEL: Record<string, string> = { takeProfit: '익절', stopLoss: '손절', timeout: '시간 만료' };

type Target = 'all' | 'paper' | 'live';
type Verdict = 'all' | 'block' | 'pass' | 'wrong';

export default function AiDecisions({ strategyId }: { strategyId: string }) {
  const [target, setTarget] = useState<Target>('all');
  const [verdict, setVerdict] = useState<Verdict>('block');
  const [summary, setSummary] = useState<MlDecisionSummary | null>(null);
  const [rows, setRows] = useState<MlDecisionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getMlDecisions(strategyId, target, showSkipped);
      setSummary(r.summary);
      setRows(r.rows);
    } catch (e: any) {
      setMsg(e.response?.data?.error ?? e.message);
    }
  }, [strategyId, target, showSkipped]);

  useEffect(() => {
    setSummary(null); setRows([]); setMsg('');
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const evaluateNow = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await evaluateMlDecisions(strategyId);
      setMsg(`평가 완료 ${r.done}건 · 아직 결과 안 난 판정 ${r.pending}건`);
      await load();
    } catch (e: any) {
      setMsg(e.response?.data?.error ?? e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!summary) return null;
  if (summary.total === 0) {
    return (
      <div className="card text-xs text-gray-500">
        <p className="section-title mb-1">AI 판정 기록</p>
        아직 판정 기록이 없습니다. 가상 지갑/실제 거래에 필터를 켜면 신호마다 AI 판정(통과/차단)이 기록되고,
        결과가 나온 뒤 "그때 진입했다면?"을 자동으로 계산해 AI가 맞았는지 보여줍니다.
      </div>
    );
  }

  const { blocked: b, passed: p } = summary;
  const rate = (n: number, d: number) => (d > 0 ? `${(n / d * 100).toFixed(0)}%` : '-');
  const shown = rows.filter(r =>
    verdict === 'all' ? true : verdict === 'block' ? !r.pass : verdict === 'pass' ? r.pass : r.correct === false
  );

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="section-title">AI 판정 기록 — 실전에서 맞았나?</p>
          <p className="text-xs text-gray-500 mt-0.5">
            판정 시각·가격에 진입했다고 가정하고 같은 매매 설정으로 결과를 계산합니다 (서버가 1시간마다 자동 평가).
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={evaluateNow} disabled={busy}
            className="px-3 py-1.5 rounded-lg text-xs border border-border text-gray-400 hover:text-gray-200 disabled:opacity-40">
            {busy ? '평가 중...' : '지금 평가'}
          </button>
          <button onClick={() => downloadMlDecisions(strategyId).catch(e => setMsg(e.message))}
            className="px-3 py-1.5 rounded-lg text-xs border border-border text-gray-400 hover:text-gray-200">
            CSV 내려받기
          </button>
        </div>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div className="bg-surface rounded-lg p-3">
          <div className="text-gray-500">차단 {b.total}건 (평가 {b.evaluated})</div>
          <div className="text-gray-200 mt-1">맞음 <span className="font-semibold">{rate(b.correct, b.evaluated)}</span></div>
          <div className="text-gray-600 mt-0.5">진입했다면 평균 {b.evaluated ? pct(b.avgNetPct) : '-'}</div>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <div className="text-gray-500">통과 {p.total}건 (평가 {p.evaluated})</div>
          <div className="text-gray-200 mt-1">맞음 <span className="font-semibold">{rate(p.correct, p.evaluated)}</span></div>
          <div className="text-gray-600 mt-0.5">평균 {p.evaluated ? pct(p.avgNetPct) : '-'}</div>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <div className="text-gray-500">AI 효과 (차단분 합계)</div>
          <div className={`mt-1 font-semibold ${summary.aiEffectSumPct >= 0 ? 'text-up' : 'text-down'}`}>{b.evaluated ? pct(summary.aiEffectSumPct, 0) : '-'}</div>
          <div className="text-gray-600 mt-0.5">+ = 피한 손실 &gt; 놓친 수익</div>
        </div>
        <div className="bg-surface rounded-lg p-3">
          <div className="text-gray-500">실전 AUC</div>
          <div className={`mt-1 font-semibold ${summary.auc === null ? 'text-gray-500' : summary.auc >= 0.55 ? 'text-up' : 'text-down'}`}>
            {summary.auc === null ? '표본 부족' : summary.auc.toFixed(2)}
          </div>
          <div className="text-gray-600 mt-0.5">0.5 = 무작위 · 평가 10건 이상부터</div>
        </div>
      </div>
      {b.evaluated > 0 && p.evaluated > 0 && (
        <p className="text-xs text-gray-500">
          좋은 거래 비율 — 차단된 신호 {rate(b.goodCount, b.evaluated)} vs 통과한 신호 {rate(p.goodCount, p.evaluated)}.
          {' '}AI가 의미 있으면 차단된 쪽이 확실히 낮아야 합니다.
        </p>
      )}
      <p className="text-xs text-gray-600">
        평가 대기 {summary.pending}건{summary.unresolved > 0 && ` · 30일 넘게 결과 미확정 ${summary.unresolved}건`} — 판정 후 최소 2시간이 지나고 거래가 끝나야(익절·손절·시간 만료) 평가됩니다.
        {summary.skipped > 0 && ` 이미 보유 중일 때 나온 중복 판정 ${summary.skipped}건은 통계에서 뺐습니다 (이전 버전에서 생긴 기록).`}
      </p>
      {msg && <p className="text-xs text-gray-400">{msg}</p>}

      {/* 필터 */}
      <div className="flex flex-wrap gap-1.5 text-xs">
        {([['all', '전체'], ['paper', '가상 지갑'], ['live', '실제 거래']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTarget(k)}
            className={`px-2.5 py-1 rounded-md border ${target === k ? 'border-accent/40 text-accent bg-accent/10' : 'border-border text-gray-500'}`}>{l}</button>
        ))}
        <span className="w-2" />
        <label className="flex items-center gap-1 text-gray-500 cursor-pointer">
          <input type="checkbox" checked={showSkipped} onChange={e => setShowSkipped(e.target.checked)} /> 중복 판정 보기
        </label>
        <span className="w-2" />
        {([['block', '차단만'], ['pass', '통과만'], ['wrong', '틀린 것만'], ['all', '전체']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setVerdict(k)}
            className={`px-2.5 py-1 rounded-md border ${verdict === k ? 'border-accent/40 text-accent bg-accent/10' : 'border-border text-gray-500'}`}>{l}</button>
        ))}
      </div>

      {/* 목록 */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-border text-left">
              <th className="pb-2 pr-3 font-medium">판정 시각</th>
              <th className="pb-2 pr-3 font-medium">코인</th>
              <th className="pb-2 pr-3 font-medium">판정</th>
              <th className="pb-2 pr-3 font-medium">AI 점수 / 기준</th>
              <th className="pb-2 pr-3 font-medium">판정 가격</th>
              <th className="pb-2 pr-3 font-medium" title="판정 시각·가격에 진입했다고 가정한 시뮬레이션 결과 (차단된 신호는 '막지 않았다면')">가정 결과</th>
              <th className="pb-2 pr-3 font-medium" title="통과 판정 직후 실제로 열린 포지션">실제 진입</th>
              <th className="pb-2 font-medium">AI</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.id} className={`border-b border-border/40 ${r.skipReason ? 'opacity-40' : ''}`}>
                <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">
                  {fmtDateTime(r.decidedAt)}
                  <span className="ml-1 text-gray-600">{r.target === 'live' ? '실' : '가'}</span>
                </td>
                <td className="py-1.5 pr-3">
                  <a href={`https://www.binance.com/en/futures/${r.symbol}`} target="_blank" rel="noreferrer" className="text-gray-200 hover:text-accent">
                    {r.symbol.replace('USDT', '')}
                  </a>
                </td>
                <td className={`py-1.5 pr-3 ${r.pass ? 'text-up' : 'text-warn'}`}>{r.pass ? '통과' : '차단'}</td>
                <td className="py-1.5 pr-3 num text-gray-300">{(r.prob * 100).toFixed(0)}% / {(r.threshold * 100).toFixed(0)}%</td>
                <td className="py-1.5 pr-3 num text-gray-300">{price(r.price)}</td>
                <td className="py-1.5 pr-3 num whitespace-nowrap">
                  {r.evalStatus === 'done' ? (
                    <span title={`청산 ${r.simExitTime ? fmtDateTime(r.simExitTime) : ''} @ ${price(r.simExitPrice)} · 그리드 ${r.simGrids ?? 0}개 · 가격 손익 ${pct(r.simGrossPnlPct ?? 0)}`}>
                      <span className={(r.simNetPnlPct ?? 0) >= 0 ? 'text-up' : 'text-down'}>{pct(r.simNetPnlPct ?? 0)}</span>
                      <span className="text-gray-500"> {EXIT_LABEL[r.simExitReason ?? ''] ?? ''} @ {price(r.simExitPrice)}</span>
                    </span>
                  ) : r.evalStatus === 'unresolved' ? <span className="text-gray-600">미확정</span> : <span className="text-gray-600">대기</span>}
                </td>
                <td className="py-1.5 pr-3 num whitespace-nowrap">
                  {r.skipReason === 'holding' ? <span className="text-gray-500">이미 보유 중</span>
                    : !r.pass ? <span className="text-gray-600">진입 안 함</span>
                    : !r.actual ? <span className="text-gray-600" title="잔액 부족·주문 실패 등으로 진입하지 못했거나 기록을 찾지 못함">없음</span>
                    : r.actual.status === 'open' ? <span className="text-gray-300">보유 중 @ {price(r.actual.entryPrice)}</span>
                    : <span className={(r.actual.netPnlPct ?? 0) >= 0 ? 'text-up' : 'text-down'}>{pct(r.actual.netPnlPct ?? 0)}</span>}
                </td>
                <td className="py-1.5">
                  {r.correct === null ? <span className="text-gray-600">⏳</span> : r.correct ? <span className="text-up">✅ 맞음</span> : <span className="text-down">❌ 틀림</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="text-xs text-gray-600 text-center py-3">해당하는 판정이 없습니다.</p>}
      </div>
      <p className="text-[11px] text-gray-600">
        가정 결과는 실제 거래가 아니라 "그 시각·가격에 진입했다면"을 계산한 값입니다 (차단된 신호도 막지 않았다면 어땠는지 계산). 실제 진입은 '실제 진입' 칸을 보세요.
        맞음 기준은 모델의 학습 목표와 같습니다 — 큰 손실 피하기: 진입했다면 '큰 손실'이었는지 / 수익 여부: 순손익이 플러스였는지.
        차단이 맞음 = 실제로 나쁜 거래를 막음, 통과가 맞음 = 좋은 거래를 들여보냄. 결과 칸에 마우스를 올리면 청산 시각·그리드 체결 수가 보입니다. 최근 300건까지 표시 (전체는 CSV).
      </p>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getStrategies, getMlFilter, trainMlFilter, updateMlFilter, deleteMlFilter, downloadMlSamples, MlFilterInfo, MlDataInfo, MlJobInfo, MlThresholdRow, MlTarget } from '../utils/api';
import { StrategyConfig } from '../types';
import { fmtDate, fmtDateTime } from '../utils/datetime';
import AiDecisions from './AiDecisions';
import AiSkew from './AiSkew';

const pct = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;

export default function AiFilter() {
  const [strategies, setStrategies] = useState<StrategyConfig[]>([]);
  const [strategyId, setStrategyId] = useState('');
  const [filter, setFilter] = useState<MlFilterInfo | null>(null);
  const [data, setData] = useState<MlDataInfo | null>(null);
  const [job, setJob] = useState<MlJobInfo | null>(null);
  const [days, setDays] = useState(180);
  const [reset, setReset] = useState(false);
  const [includeLive, setIncludeLive] = useState(true);
  const [includeDecisions, setIncludeDecisions] = useState(true);
  const [liveWeight, setLiveWeight] = useState(2);
  const [target, setTarget] = useState<MlTarget>('avoidLoss');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getStrategies().then(list => {
      setStrategies(list);
      if (list.length > 0) setStrategyId(list[0].id);
    });
  }, []);

  // 저장된 학습 설정(목표 등)은 전략을 바꿨을 때 한 번만 화면에 반영 — 3초 갱신마다 덮어쓰면 사용자가 고른 값이 되돌아감
  const settingsLoadedFor = useRef('');
  const load = async (id: string) => {
    if (!id) return;
    try {
      const r = await getMlFilter(id);
      setFilter(r.filter);
      setData(r.data);
      if (settingsLoadedFor.current !== id) {
        settingsLoadedFor.current = id;
        const st = r.data?.state;
        if (st?.target) setTarget(st.target);
        if (st) { setIncludeLive(st.includeLive ?? true); setIncludeDecisions(st.includeDecisions ?? true); setLiveWeight(st.liveWeight ?? 2); }
      }
      setJob(r.job);
      return r.job;
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message);
    }
  };

  // 학습 중이면 3초마다 진행 상황 갱신
  useEffect(() => {
    setFilter(null); setData(null); setJob(null); setError(''); setReset(false);
    load(strategyId);
    pollRef.current = setInterval(() => { load(strategyId); }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [strategyId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(strategyId); }
    catch (e: any) { setError(e.response?.data?.error ?? e.message); }
    finally { setBusy(false); }
  };

  const training = job?.status === 'running';
  const m = filter?.metrics;
  const hasData = (data?.backtest.count ?? 0) > 0 && !data?.configChanged && !data?.featureChanged;
  const scoreLabel = (filter?.target ?? 'profit') === 'avoidLoss' ? '안전 점수' : '예상 승률';
  const pendingLive = Math.max(0, (data?.liveTradesAvailable ?? 0) - (data?.live.count ?? 0));
  const current: MlThresholdRow | undefined = m?.table.find(r => Math.abs(r.threshold - (filter?.threshold ?? -1)) < 1e-6);

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-lg font-bold text-gray-100">AI 진입 필터</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          전략 신호가 떠도, 과거 비슷한 상황에서 손실로 끝난 경우가 많았던 진입은 AI가 걸러냅니다.{' '}
          <Link to="/guide" className="text-accent hover:underline">사용법 →</Link>
        </p>
      </div>

      {/* 전략 선택 + 학습 */}
      <div className="card space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <label className="label">전략</label>
            <select value={strategyId} onChange={e => setStrategyId(e.target.value)} className="input w-full">
              {strategies.length === 0 && <option value="">저장된 전략 없음</option>}
              {strategies.map(s => <option key={s.id} value={s.id}>{s.name} ({s.side === 'LONG' ? '롱' : '숏'})</option>)}
            </select>
          </div>
          <div>
            <label className="label">{hasData && !reset ? '처음 수집 기간' : '학습 기간'}</label>
            <select value={days} onChange={e => setDays(+e.target.value)} className="input" disabled={training || (hasData && !reset)}>
              <option value={90}>90일</option>
              <option value={180}>180일 (권장)</option>
              <option value={365}>365일</option>
            </select>
          </div>
          <div>
            <label className="label">학습 목표</label>
            <select value={target} onChange={e => setTarget(e.target.value as MlTarget)} className="input" disabled={training}>
              <option value="avoidLoss">큰 손실 피하기 (추천)</option>
              <option value="profit">수익 여부</option>
            </select>
          </div>
          <button
            onClick={() => run(() => trainMlFilter(strategyId, { days, reset, includeLive, includeDecisions, liveWeight, target }))}
            disabled={!strategyId || training || busy}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {training ? '학습 중...' : hasData && !reset ? '새 데이터 추가 + 재학습' : filter ? '다시 학습' : '학습 시작'}
          </button>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-gray-400">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={includeLive} onChange={e => setIncludeLive(e.target.checked)} disabled={training} />
            내 실거래 기록도 학습
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer" title="채점이 끝난 AI 판정(차단 신호 포함)을 실시간 입력값 그대로 학습에 사용 — 같은 신호의 백테스트 데이터를 대체">
            <input type="checkbox" checked={includeDecisions} onChange={e => setIncludeDecisions(e.target.checked)} disabled={training} />
            AI 판정 기록도 학습
          </label>
          {includeLive && (
            <label className="flex items-center gap-1.5">
              실거래 가중치
              <select value={liveWeight} onChange={e => setLiveWeight(+e.target.value)} className="input py-0.5 text-xs" disabled={training}>
                {[1, 2, 3, 5].map(w => <option key={w} value={w}>{w}배</option>)}
              </select>
            </label>
          )}
          {hasData && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={reset} onChange={e => setReset(e.target.checked)} disabled={training} />
              백테스트 데이터 처음부터 다시 수집
            </label>
          )}
        </div>
        <p className="text-xs text-gray-600">
          {hasData && !reset
            ? '저장된 학습 데이터에 마지막 수집 이후 기간만 추가하고, 누적된 전체 데이터로 다시 학습합니다 (보통 1~5분).'
            : '처음에는 전체 알트코인 장기 백테스트로 학습 데이터를 만들어서 5~15분 걸립니다.'}
          {' '}이 페이지를 닫아도 서버에서 계속 진행됩니다.
          {data?.configChanged && ' 전략 설정이 바뀌어 백테스트 데이터를 새로 수집합니다 (실거래 데이터는 유지).'}
          {data?.featureChanged && ' 서버 업데이트로 AI 입력 지표가 바뀌어 처음부터 다시 수집합니다.'}
        </p>
        <p className="text-xs text-gray-600">
          {target === 'avoidLoss'
            ? "큰 손실 피하기: '이긴 거래 수익 중앙값의 2배(최소 3%) 이상 잃은 거래'를 피하도록 학습합니다. 그리드 숏처럼 자주 조금 벌고 가끔 크게 잃는 전략에 적합합니다."
            : '수익 여부: 순손익이 플러스로 끝날지를 맞히도록 학습합니다.'}
        </p>
        {training && job && (
          <div className="text-xs text-gray-400">
            <div className="flex justify-between mb-1">
              <span>{job.mode === 'auto' && '[자동 업데이트] '}{job.phase}{job.total > 0 && ` · ${job.done}/${job.total}`}</span>
              <span>{Math.floor((Date.now() - job.startedAt) / 1000)}초 경과</span>
            </div>
            <div className="h-1.5 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${job.total > 0 ? (job.done / job.total) * 100 : 3}%` }} />
            </div>
          </div>
        )}
        {job?.status === 'error' && <p className="text-sm text-down">학습 실패: {job.error}</p>}
        {error && <p className="text-sm text-down">{error}</p>}
      </div>

      {data?.state && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="section-title">저장된 학습 데이터</p>
              <p className="text-xs text-gray-500 mt-1 space-x-3">
                <span>백테스트 <span className="text-gray-200 num">{data.backtest.count.toLocaleString()}</span>건
                  {data.backtest.from && <> ({fmtDate(data.backtest.from)} ~ {fmtDate(data.backtest.to!)})</>}</span>
                <span>실거래 <span className="text-gray-200 num">{data.live.count.toLocaleString()}</span>건
                  {pendingLive > 0 && <span className="text-warn"> (+{pendingLive}건 다음 학습 때 추가)</span>}</span>
              </p>
              {data.state.lastCollect && (
                <p className="text-xs text-gray-600 mt-0.5">
                  마지막 수집 {fmtDateTime(data.state.lastCollect.at)} · +{data.state.lastCollect.added}건 · 코인 {data.state.lastCollect.coins}개
                  {data.state.lastCollect.failed > 0 && ` (실패 ${data.state.lastCollect.failed})`}
                </p>
              )}
            </div>
            <button
              onClick={() => run(() => downloadMlSamples(strategyId))}
              disabled={busy || data.backtest.count + data.live.count === 0}
              className="px-3 py-1.5 rounded-lg text-xs border border-border text-gray-400 hover:text-gray-200 disabled:opacity-40"
            >
              CSV 내려받기
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border/50">
            <button
              onClick={() => run(() => updateMlFilter(strategyId, { autoUpdate: !data.state!.autoUpdate }))}
              disabled={busy || !filter}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 ${data.state.autoUpdate ? 'text-up border-up/40 bg-up/15' : 'text-gray-400 border-border hover:text-gray-200'}`}
            >
              자동 업데이트 {data.state.autoUpdate ? 'ON' : 'OFF'}
            </button>
            <p className="text-xs text-gray-500 flex-1 min-w-[200px]">
              {data.state.autoEveryDays || 7}일마다 새 백테스트·실거래 데이터를 추가하고 재학습합니다. 사용 중인 필터는 새 모델이 검증을 통과할 때만 추천 기준으로 교체되고, 미달이면 기존 모델을 유지합니다.
              {data.state.lastAuto && (
                <span className={`block mt-0.5 ${data.state.lastAuto.ok ? 'text-gray-400' : 'text-warn'}`}>
                  최근: {fmtDateTime(data.state.lastAuto.at)} — {data.state.lastAuto.message}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      {filter && m && (
        <>
          {/* 사용 상태 */}
          <div className={`card border ${filter.applyPaper || filter.applyLive ? 'border-up/30 bg-up/5' : 'border-border'}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="section-title">
                  {filter.applyPaper || filter.applyLive
                    ? `🤖 필터 사용 중 — ${[filter.applyPaper && '가상 지갑', filter.applyLive && '실제 거래'].filter(Boolean).join(' · ')}`
                    : '필터 꺼짐'}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {scoreLabel} <span className="text-gray-200 font-semibold">{(filter.threshold * 100).toFixed(1)}%</span> 미만이면 진입하지 않음
                  {current && <> · 검증 구간 기준 신호의 {current.keptPct}%만 진입</>}
                  {' · '}학습 {fmtDateTime(filter.trainedAt)} ({filter.days}일)
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                {([['applyPaper', '가상 지갑'], ['applyLive', '실제 거래']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => {
                      if (key === 'applyLive' && !filter.applyLive && !confirm('실제 거래에 AI 필터를 적용할까요? 가상 지갑에서 먼저 효과를 확인하는 것을 권장합니다.')) return;
                      run(() => updateMlFilter(strategyId, { [key]: !filter[key] }));
                    }}
                    disabled={busy || filter.outdated}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 ${filter[key] ? 'text-up border-up/40 bg-up/15' : 'text-gray-400 border-border hover:text-gray-200'}`}
                  >
                    {label} {filter[key] ? 'ON' : 'OFF'}
                  </button>
                ))}
                <button
                  onClick={() => { if (confirm('학습된 모델을 삭제할까요?')) run(() => deleteMlFilter(strategyId)); }}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg text-xs border border-border text-gray-500 hover:text-down hover:border-down/30"
                >
                  삭제
                </button>
              </div>
            </div>
            {filter.stale && (
              <p className="text-xs text-warn mt-2">⚠ 학습 후 전략 조건/매매 설정이 바뀌었습니다. 지금 설정으로 다시 학습하세요 (그 전까지는 옛 설정 기준 판단).</p>
            )}
            {filter.outdated && (
              <p className="text-xs text-down mt-2">⚠ 서버 업데이트로 모델 형식이 바뀌어 이 모델은 사용되지 않습니다. 다시 학습하세요.</p>
            )}
            {m.recommended === null && (
              <p className="text-xs text-warn mt-2">
                ⚠ 검증 구간에서 필터 효과가 확인되지 않았습니다 (구분력 AUC 0.55 미만이거나 순손익 합이 '필터 없음'보다 낫지 않음).
                표에서 일부 기준이 좋아 보여도 우연일 가능성이 커서 켜지 않는 것을 권장합니다. 학습 기간을 늘려 다시 학습해볼 수 있습니다.
              </p>
            )}
          </div>

          {/* 검증 결과 */}
          <div className="card overflow-x-auto">
            <p className="section-title mb-1">검증 결과 — 학습에 안 쓴 최근 {m.testSamples}건 ({fmtDate(m.testFrom)} 이후)</p>
            <p className="text-xs text-gray-500 mb-3">
              앞 {m.trainSamples}건으로 학습한 모델이 그 뒤 거래를 얼마나 잘 걸렀는지입니다 (순손익 기준).
              구분력(AUC) <span className={m.auc >= 0.6 ? 'text-up' : m.auc >= 0.55 ? 'text-gray-300' : 'text-down'}>{m.auc.toFixed(2)}</span>
              {' '}— 0.5는 동전 던지기, 0.6 이상이면 의미 있는 수준.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 border-b border-border text-left text-xs">
                  <th className="pb-2 pr-3 font-medium">기준 {scoreLabel}</th>
                  <th className="pb-2 pr-3 font-medium">진입 비율</th>
                  <th className="pb-2 pr-3 font-medium">승률</th>
                  <th className="pb-2 pr-3 font-medium">EV(순손익)</th>
                  <th className="pb-2 pr-3 font-medium">순손익 합</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border/40 text-gray-400">
                  <td className="py-2 pr-3">필터 없음</td>
                  <td className="py-2 pr-3 num">100%</td>
                  <td className="py-2 pr-3 num">{(m.baseline.stats.winRate * 100).toFixed(1)}%</td>
                  <td className="py-2 pr-3 num">{pct(m.baseline.stats.expectedValuePct)}</td>
                  <td className="py-2 pr-3 num">{pct(m.baseline.sumPct, 0)}</td>
                  <td />
                </tr>
                {m.table.map(r => {
                  const selected = Math.abs(r.threshold - filter.threshold) < 1e-6;
                  const better = r.sumPct > m.baseline.sumPct;
                  return (
                    <tr key={r.threshold} className={`border-b border-border/40 ${selected ? 'bg-accent/10' : ''}`}>
                      <td className="py-2 pr-3 num text-gray-200">
                        {(r.threshold * 100).toFixed(1)}%
                        {m.recommended !== null && Math.abs(r.threshold - m.recommended) < 1e-6 && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-up/15 text-up">추천</span>}
                      </td>
                      <td className="py-2 pr-3 num text-gray-300">{r.keptPct}% <span className="text-gray-600">({r.trades}건)</span></td>
                      <td className="py-2 pr-3 num text-gray-300">{(r.stats.winRate * 100).toFixed(1)}%</td>
                      <td className={`py-2 pr-3 num ${r.stats.expectedValuePct > m.baseline.stats.expectedValuePct ? 'text-up' : 'text-down'}`}>{pct(r.stats.expectedValuePct)}</td>
                      <td className={`py-2 pr-3 num font-semibold ${better ? 'text-up' : 'text-down'}`}>{pct(r.sumPct, 0)}</td>
                      <td className="py-2 text-right">
                        {selected ? <span className="text-xs text-accent">사용 중</span> : (
                          <button onClick={() => run(() => updateMlFilter(strategyId, { threshold: r.threshold }))} disabled={busy}
                            className="text-xs text-accent hover:underline disabled:opacity-40">이 기준 사용</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-gray-600 mt-3">
              "순손익 합"은 진입 1건당 같은 금액을 넣었을 때의 총 수익(증거금 대비 %)입니다. 기준을 높이면 EV는 오르지만 진입 수가 줄어 총 수익은 줄 수 있습니다.
              학습 데이터 {m.samples}건
              {m.sources && <> (백테스트 {m.sources.backtest} · 실거래 {m.sources.live}건 ×{m.sources.liveWeight}배 가중{m.sources.liveReplaced > 0 && ` · 같은 신호의 백테스트 ${m.sources.liveReplaced}건은 실거래로 대체`}{(m.sources.decision ?? 0) > 0 && ` · AI 판정 기록 ${m.sources.decision}건(백테스트 ${m.sources.decisionReplaced ?? 0}건 대체)`}{(m.sources.liveRealtime ?? 0) > 0 && ` · 실거래 중 ${m.sources.liveRealtime}건은 판정 당시 실시간 입력값 사용`})</>}
              {m.dataFrom && <> · {fmtDate(m.dataFrom)} ~ {fmtDate(m.dataTo!)}</>}.
              {m.liveTest && m.liveTest.samples > 0 && (
                <> 검증 구간 실거래 {m.liveTest.samples}건만 본 AUC: {m.liveTest.auc === null ? '표본 부족(20건 미만 또는 한쪽 결과만)' : m.liveTest.auc.toFixed(2)}.</>
              )}
            </p>
            <p className="text-xs text-gray-600 mt-1">
              학습 목표: {filter.target === 'avoidLoss'
                ? <>큰 손실 피하기 (순손익 -{m.lossCutPct}% 이하 = 큰 손실, 안전 비율 {m.labelPosPct}%) — 안전 점수 = 큰 손실이 아닐 확률</>
                : <>수익 여부{m.labelPosPct !== undefined && ` (이긴 거래 ${m.labelPosPct}%)`}</>}
              {m.params && <> · 파라미터: 깊이 {m.params.depth}, 리프 최소 {m.params.minLeaf}, 학습률 {m.params.lr}, 트리 {m.params.trees}</>}
            </p>
            {m.search && m.search.length > 0 && (
              <details className="mt-2 text-xs text-gray-500">
                <summary className="cursor-pointer hover:text-gray-300">파라미터 탐색 결과 ({m.search.length}개 조합 · 학습 구간 안쪽 검증 AUC)</summary>
                <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 num">
                  {m.search.map((r, i) => (
                    <span key={i} className={i === 0 ? 'text-accent' : ''}>
                      깊이{r.depth} 리프{r.minLeaf} lr{r.lr}×{r.trees}: {r.auc.toFixed(3)}
                    </span>
                  ))}
                </div>
                {m.missingPct && Object.keys(m.missingPct).length > 0 && (
                  <p className="mt-1.5">
                    결측 비율: {Object.entries(m.missingPct).map(([k, v]) => `${k} ${v}%`).join(' · ')}
                    {' '}(미결제약정·롱숏비율은 바이낸스가 최근 30일치만 제공 — 데이터가 쌓일수록 줄어듦)
                  </p>
                )}
              </details>
            )}
          </div>

          {/* 중요도 */}
          <div className="card">
            <p className="section-title mb-3">AI가 주로 본 지표</p>
            <div className="space-y-1.5">
              {m.importance.slice(0, 8).map(f => (
                <div key={f.name} className="flex items-center gap-2 text-xs">
                  <span className="w-28 text-gray-400 flex-shrink-0">{f.label}</span>
                  <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
                    <div className="h-full bg-accent/70" style={{ width: `${Math.min(100, f.pct * 2)}%` }} />
                  </div>
                  <span className="w-12 text-right text-gray-500 num">{f.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {strategyId && <AiDecisions strategyId={strategyId} />}
      {strategyId && <AiSkew strategyId={strategyId} />}

      {!filter && !training && strategyId && (
        <div className="card text-sm text-gray-500 text-center py-6">이 전략은 아직 학습된 AI 필터가 없습니다.</div>
      )}
    </div>
  );
}

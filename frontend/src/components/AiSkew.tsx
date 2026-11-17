import { useState, useEffect } from 'react';
import { getMlSkew, MlSkewReport } from '../utils/api';

// 학습–실전 입력값 차이 점검: 같은 신호에서 "실전에 AI가 본 값" vs "학습 데이터의 값" 비교.
// 차이가 큰 지표 = 모델이 학습 때와 다른 값을 보고 판단 중 → 실전 성능이 검증보다 낮은 원인 후보
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

export default function AiSkew({ strategyId }: { strategyId: string }) {
  const [report, setReport] = useState<MlSkewReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => { setReport(null); setError(''); setOpen(false); }, [strategyId]);

  const run = async () => {
    setBusy(true); setError(''); setOpen(true);
    try { setReport(await getMlSkew(strategyId)); }
    catch (e: any) { setError(e.response?.data?.error ?? e.message); }
    finally { setBusy(false); }
  };

  const unmatchedPct = report && report.comparable > 0 ? (1 - report.matched / report.comparable) * 100 : null;
  const big = report?.features.filter(f => f.pairs >= 5 && (f.stdDiff >= 0.5 || (f.corr !== null && f.corr < 0.8))) ?? [];

  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="section-title">학습–실전 입력값 차이 점검</p>
          <p className="text-xs text-gray-500 mt-0.5">
            같은 신호에서 실전에 AI가 본 지표와 학습 데이터(백테스트)의 지표를 비교합니다. 차이가 큰 지표가 있으면 실전 판정이 학습 때만큼 정확하지 않을 수 있습니다.
          </p>
        </div>
        <button onClick={run} disabled={busy}
          className="px-3 py-1.5 rounded-lg text-xs border border-border text-gray-400 hover:text-gray-200 disabled:opacity-40">
          {busy ? '점검 중...' : report ? '다시 점검' : '점검 실행'}
        </button>
      </div>
      {error && <p className="text-xs text-down">{error}</p>}

      {open && report && (
        report.matched < 5 ? (
          <p className="text-xs text-gray-500">
            비교할 짝이 {report.matched}건뿐입니다 (판정 기록 {report.decisions}건 중 백테스트 수집이 끝난 구간 {report.comparable}건).
            AI 필터를 켠 상태로 판정이 쌓이고, 학습(또는 자동 업데이트)으로 그 기간의 백테스트 데이터가 수집되면 점검할 수 있습니다.
          </p>
        ) : (
          <>
            <div className="text-xs text-gray-400 space-y-1">
              <p>
                비교한 신호 {report.matched}건 (판정 {report.comparable}건 중).
                {unmatchedPct !== null && (
                  <span className={unmatchedPct > 30 ? 'text-warn' : ''}>
                    {' '}백테스트에 같은 신호가 없는 판정 {unmatchedPct.toFixed(0)}%
                    {unmatchedPct > 30 && ' — 실시간 스캐너와 백테스트가 신호를 다르게 잡고 있습니다 (진입 시점·조건 계산 차이)'}
                  </span>
                )}
              </p>
              <p className={big.length ? 'text-warn' : 'text-up'}>
                {big.length ? `차이가 큰 지표 ${big.length}개: ${big.map(f => f.label).join(', ')}` : '큰 차이가 나는 지표 없음'}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-border text-left">
                    <th className="pb-2 pr-3 font-medium">지표</th>
                    <th className="pb-2 pr-3 font-medium">실전 평균</th>
                    <th className="pb-2 pr-3 font-medium">학습 평균</th>
                    <th className="pb-2 pr-3 font-medium">평균 차이</th>
                    <th className="pb-2 pr-3 font-medium" title="평균 차이 ÷ 학습 데이터 표준편차. 0.5 이상이면 큰 차이">차이 크기</th>
                    <th className="pb-2 pr-3 font-medium" title="같은 신호의 두 값이 얼마나 같이 움직이는지. 1에 가까울수록 같은 값">상관</th>
                    <th className="pb-2 font-medium">결측 (실전/학습)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.features.map(f => {
                    const flagged = f.pairs >= 5 && (f.stdDiff >= 0.5 || (f.corr !== null && f.corr < 0.8));
                    return (
                      <tr key={f.name} className={`border-b border-border/40 ${flagged ? 'bg-warn/5' : ''}`}>
                        <td className="py-1.5 pr-3 text-gray-300">{f.label}</td>
                        <td className="py-1.5 pr-3 num text-gray-400">{f.pairs ? fmt(f.meanLive) : '-'}</td>
                        <td className="py-1.5 pr-3 num text-gray-400">{f.pairs ? fmt(f.meanTrain) : '-'}</td>
                        <td className="py-1.5 pr-3 num text-gray-400">{f.pairs ? fmt(f.meanAbsDiff) : '-'}</td>
                        <td className={`py-1.5 pr-3 num ${f.stdDiff >= 0.5 ? 'text-warn font-semibold' : 'text-gray-400'}`}>{f.pairs ? f.stdDiff.toFixed(2) : '-'}</td>
                        <td className={`py-1.5 pr-3 num ${f.corr !== null && f.corr < 0.8 ? 'text-warn' : 'text-gray-400'}`}>{f.corr === null ? '-' : f.corr.toFixed(2)}</td>
                        <td className="py-1.5 num text-gray-500">{f.missingLive}/{f.missingTrain}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-600">
              차이 크기 = 같은 신호의 두 값 차이 평균 ÷ 학습 데이터 전체 표준편차 (0.5 이상 주황). 시간대·요일·1시간 상승률처럼 진입 시각이
              캔들 중간이냐 시작이냐에 따라 원래 조금씩 다른 지표도 있습니다. 결측 = 한쪽에만 값이 없는 짝 수 (미결제약정·롱숏비율은 학습 데이터가 30일 이전이면 결측).
            </p>
          </>
        )
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { getStrategies, getStrategyComparisonActual, validateStrategy } from '../utils/api';
import { StrategyConfig, ValidationResult } from '../types';
import { netStatsOf, costSummary } from '../utils/netPnl';

type LogType = 'live' | 'paper';

interface Row {
  label: string;
  backtest: number | null;
  actual: number | null;
  fmt: (v: number) => string;
  higherIsBetter: boolean;
}

function fmtPct(v: number) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }

export default function StrategyComparison() {
  const [strategies, setStrategies] = useState<StrategyConfig[]>([]);
  const [strategyId, setStrategyId] = useState('');
  const [type, setType] = useState<LogType>('live');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actual, setActual] = useState<Awaited<ReturnType<typeof getStrategyComparisonActual>> | null>(null);
  const [backtest, setBacktest] = useState<ValidationResult | null>(null);

  useEffect(() => {
    getStrategies().then(list => {
      setStrategies(list);
      if (list.length > 0) setStrategyId(list[0].id);
    });
  }, []);

  const handleCompare = async () => {
    if (!strategyId) return;
    setLoading(true);
    setError('');
    setActual(null);
    setBacktest(null);
    try {
      const actualResult = await getStrategyComparisonActual(strategyId, type);
      setActual(actualResult);
      const backtestResult: ValidationResult = await validateStrategy({
        conditions: actualResult.conditions,
        trade: actualResult.trade,
        side: actualResult.side,
      });
      setBacktest(backtestResult);
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message);
    } finally {
      setLoading(false);
    }
  };

  // 승률(winRate)은 0~1 소수, 나머지 세 지표는 이미 퍼센트 숫자라 스케일이 다름 —
  // "차이(%p)"를 일관되게 계산하려면 전부 퍼센트 숫자 스케일로 맞춰서 저장해야 함
  // 실거래: 양쪽 다 순손익(펀딩피·수수료 반영) 기준으로 비교.
  // 가상거래: 가상 로그엔 비용 데이터가 없어 양쪽 다 가격 기준으로 비교 (사과 대 사과)
  const btNet = backtest ? netStatsOf(backtest) : null;
  const useNet = !!actual?.liveExtra && !!btNet?.isNet;
  const bt = backtest && btNet ? (useNet ? btNet : backtest) : null;
  const rows: Row[] | null = (bt && backtest && actual) ? [
    { label: '승률', backtest: bt.winRate * 100, actual: actual.actual.winRate * 100, fmt: v => `${v.toFixed(1)}%`, higherIsBetter: true },
    { label: '평균 수익', backtest: bt.avgProfitPct, actual: actual.actual.avgProfitPct, fmt: fmtPct, higherIsBetter: true },
    { label: '평균 손실', backtest: bt.avgLossPct, actual: actual.actual.avgLossPct, fmt: v => `-${v.toFixed(2)}%`, higherIsBetter: false },
    { label: useNet ? '기댓값 (EV, 순손익)' : '기댓값 (EV)', backtest: bt.expectedValuePct, actual: actual.actual.expectedValuePct, fmt: fmtPct, higherIsBetter: true },
    // 실거래: 비용 제외한 가격 기준 EV도 참고로 표시 — 차이 중 얼마가 비용 모델 오차 때문인지 구분용
    ...(useNet && actual.liveExtra ? [
      { label: '└ 가격 기준 EV', backtest: backtest.expectedValuePct, actual: actual.liveExtra.gross.expectedValuePct, fmt: fmtPct, higherIsBetter: true },
    ] : []),
  ] : null;

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-lg font-bold text-gray-100">백테스트 vs 실제 비교</h1>
        <p className="text-xs text-gray-500 mt-0.5">전략이 백테스트 예측대로 실제로도 작동하는지 큰 그림을 확인합니다</p>
      </div>

      <div className="card space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[180px]">
            <label className="label">전략</label>
            <select
              value={strategyId}
              onChange={e => setStrategyId(e.target.value)}
              className="input w-full"
            >
              {strategies.length === 0 && <option value="">저장된 전략 없음</option>}
              {strategies.map(s => (
                <option key={s.id} value={s.id}>{s.name} ({s.side === 'LONG' ? '롱' : '숏'})</option>
              ))}
            </select>
          </div>

          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setType('live')}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${type === 'live' ? 'bg-accent/15 text-accent' : 'text-gray-500 hover:text-gray-300'}`}
            >
              실제 거래
            </button>
            <button
              onClick={() => setType('paper')}
              className={`px-3 py-1.5 text-sm font-medium transition-colors border-l border-border ${type === 'paper' ? 'bg-accent/15 text-accent' : 'text-gray-500 hover:text-gray-300'}`}
            >
              가상 지갑
            </button>
          </div>

          <button
            onClick={handleCompare}
            disabled={!strategyId || loading}
            className="px-4 py-1.5 rounded-lg text-sm font-medium bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? '비교 중... (전체 알트코인 백테스트라 다소 걸림)' : '비교하기'}
          </button>
        </div>
        {error && <p className="text-sm text-down">{error}</p>}
      </div>

      {actual && actual.actual.trades === 0 && (
        <div className="card text-sm text-gray-500 text-center py-6">
          이 전략의 {type === 'live' ? '실거래' : '가상거래'} 기록이 아직 없습니다.
        </div>
      )}

      {backtest && backtest.totalSignals === 0 && (
        <div className="card text-sm text-warn text-center py-4">
          백테스트 조건을 충족한 과거 신호가 없습니다 — {backtest.message ?? '조건 범위를 넓혀보세요.'}
        </div>
      )}

      {rows && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 border-b border-border text-left">
                <th className="pb-2 pr-3 font-medium">지표</th>
                <th className="pb-2 pr-3 font-medium">백테스트 예측</th>
                <th className="pb-2 pr-3 font-medium">실제 ({type === 'live' ? '실거래' : '가상거래'})</th>
                <th className="pb-2 font-medium">차이</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const diff = (r.actual ?? 0) - (r.backtest ?? 0);
                const diffGood = r.higherIsBetter ? diff >= 0 : diff <= 0;
                return (
                  <tr key={r.label} className="border-b border-border/40">
                    <td className="py-2 pr-3 text-gray-400">{r.label}</td>
                    <td className="py-2 pr-3 text-gray-300 num">{r.fmt(r.backtest ?? 0)}</td>
                    <td className="py-2 pr-3 text-gray-100 num font-semibold">{r.fmt(r.actual ?? 0)}</td>
                    <td className={`py-2 num ${diffGood ? 'text-up' : 'text-down'}`}>
                      {diff >= 0 ? '+' : ''}{diff.toFixed(2)}%p
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-xs text-gray-600 mt-3">
            백테스트: 과거 {backtest!.coinsAnalyzed}개 알트코인 대상 {backtest!.totalSignals}건 신호 · 실제: {actual!.actual.trades}건 거래 기준.
            표본 수가 적으면(특히 실제 거래) 차이가 통계적으로 유의미하지 않을 수 있습니다.
          </p>
          {actual!.liveExtra && (
            <p className="text-xs text-gray-600 mt-1">
              양쪽 모두 펀딩피·수수료를 뺀 순손익 기준입니다 (증거금 대비).
              실거래 건당 평균 비용 {fmtPct(actual!.liveExtra.avgCostPct)}
              {costSummary(backtest!) && <> · 백테스트 {costSummary(backtest!)}</>}.
              {actual!.liveExtra.unsyncedTrades > 0 && ` 펀딩피·수수료 미반영 거래 ${actual!.liveExtra.unsyncedTrades}건은 가격 손익으로만 집계됩니다.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

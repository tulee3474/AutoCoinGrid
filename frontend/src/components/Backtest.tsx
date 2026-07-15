import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { runBacktest } from '../utils/api';
import { BacktestResult } from '../types';
import { fmtDate } from '../utils/datetime';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid
} from 'recharts';

const INTERVALS = [
  { value: '15m', label: '15분봉' },
  { value: '30m', label: '30분봉' },
  { value: '1h',  label: '1시간봉' },
  { value: '4h',  label: '4시간봉' },
  { value: '1d',  label: '일봉' },
];
const LIMIT_OPTIONS = [
  { value: 500,  label: '500개 (~1개월, 1h 기준)' },
  { value: 1000, label: '1000개 (~2개월)' },
  { value: 1500, label: '1500개 (~3개월, 최대)' },
];

function TradeRow({ trade, idx }: { trade: BacktestResult['trades'][0]; idx: number }) {
  const isWin = trade.pnlPct > 0;
  const exitLabel = { takeProfit: '익절', stopLoss: '손절', timeout: '타임아웃' }[trade.exitReason];
  const exitColor = { takeProfit: 'bg-up/15 text-up', stopLoss: 'bg-down/15 text-down', timeout: 'bg-border text-gray-400' }[trade.exitReason];
  return (
    <tr className="border-b border-border/40 text-xs hover:bg-white/3">
      <td className="py-2 text-gray-500 num">{idx + 1}</td>
      <td className="py-2 text-gray-400">{fmtDate(trade.entryTime)}</td>
      <td className="py-2 text-gray-400">{fmtDate(trade.exitTime)}</td>
      <td className="py-2 text-gray-300 num">${trade.entryPrice.toFixed(5)}</td>
      <td className="py-2 text-yellow-400 num">${trade.avgEntryPrice.toFixed(5)}</td>
      <td className="py-2 text-gray-300 num">${trade.exitPrice.toFixed(5)}</td>
      <td className={`py-2 font-bold num ${isWin ? 'text-up' : 'text-down'}`}>
        {isWin ? '+' : ''}{trade.pnlPct.toFixed(2)}%
      </td>
      <td className="py-2 text-gray-400 num">{trade.gridsFilled}개</td>
      <td className="py-2">
        <span className={`text-xs px-1.5 py-0.5 rounded ${exitColor}`}>{exitLabel}</span>
      </td>
    </tr>
  );
}

export default function Backtest() {
  const { draftConditions, draftTrade, btcDominance, backtestResult, setBacktestResult, backtesting, setBacktesting, topTickers } = useStore();
  const [symbol, setSymbol]   = useState('');
  const [interval, setInterval] = useState(draftConditions.rsi.timeframe);
  const [limit, setLimit]     = useState(1500);
  const [error, setError]     = useState<string | null>(null);

  const targetSymbol = symbol.toUpperCase().endsWith('USDT')
    ? symbol.toUpperCase()
    : symbol.toUpperCase() + 'USDT';

  const handleRun = async () => {
    if (!symbol.trim()) { setError('코인 심볼을 입력하세요 (예: SOL, PEPE, DOGE)'); return; }
    setBacktesting(true);
    setError(null);
    setBacktestResult(null);
    try {
      const result: BacktestResult = await runBacktest({
        symbol: targetSymbol,
        interval,
        limit,
        conditions: draftConditions,
        trade: draftTrade,
        btcDominance
      });
      setBacktestResult(result);
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message);
    } finally {
      setBacktesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">백테스트</h1>
        <p className="page-sub">특정 코인 하나를 골라 전략 조건으로 상세 검증합니다</p>
      </div>

      {/* 현재 전략 조건 요약 (읽기 전용) */}
      <div className="card bg-accent/5 border-accent/20">
        <div className="flex items-center justify-between mb-3">
          <p className="section-title text-accent">현재 적용 중인 전략 조건</p>
          <Link to="/strategy" className="text-xs text-accent hover:underline">전략 수정 →</Link>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
          {[
            { label: 'RSI',         value: `${draftConditions.rsi.min} ~ ${draftConditions.rsi.max}` },
            { label: '24h 상승률',  value: `+${draftConditions.priceChange24h.min}% ~ +${draftConditions.priceChange24h.max}%` },
            { label: '볼륨 배수',   value: `${draftConditions.volumeMultiplier.min}x 이상` },
            { label: '레버리지',    value: `${draftTrade.leverage}x` },
            { label: '그리드',      value: `${draftTrade.gridLevels}개 × +${draftTrade.gridSpacing}%` },
            { label: 'TP / SL',     value: `${draftTrade.takeProfitPct}% / ${draftTrade.stopLossPct}%` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-surface rounded-lg p-2.5">
              <p className="text-gray-500 mb-0.5">{label}</p>
              <p className="font-semibold text-gray-200 num">{value}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-3">
          위 조건은 <Link to="/strategy" className="text-accent hover:underline">전략 설정</Link>에서 변경됩니다.
          변경 후 이 페이지로 돌아오면 자동 반영됩니다.
        </p>
      </div>

      {/* 코인 선택 */}
      <div className="card space-y-4">
        <h2 className="section-title">코인 선택</h2>
        <p className="text-xs text-gray-500">
          테스트할 코인 심볼을 입력하세요.
          <strong className="text-gray-300"> 잡코인도 모두 가능합니다.</strong>
          USDT는 자동으로 붙습니다.
        </p>

        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-40">
            <label className="label">코인 심볼</label>
            <input
              type="text"
              className="input font-mono uppercase"
              placeholder="예: PEPE, SHIB, DOGE, SOL"
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRun()}
            />
          </div>
          <div>
            <label className="label">
              타임프레임
              <span className="text-gray-500 font-normal ml-1 text-xs">
                (전략: {draftConditions.rsi.timeframe})
              </span>
            </label>
            <select className="input w-36" value={interval} onChange={e => setInterval(e.target.value)}>
              {INTERVALS.map(i => (
                <option key={i.value} value={i.value}>
                  {i.label}{i.value === draftConditions.rsi.timeframe ? ' ★' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">데이터 기간</label>
            <select className="input w-52" value={limit} onChange={e => setLimit(+e.target.value)}>
              {LIMIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        {/* 빠른 선택 — 대시보드 24h 급등 코인 */}
        {topTickers.length > 0 ? (
          <div className="space-y-1.5">
            <span className="text-xs text-gray-500 block">
              대시보드 24h 급등 코인 (클릭하여 선택)
            </span>
            <div className="flex flex-wrap gap-2">
              {topTickers.slice(0, 12).map(t => {
                const sym = t.symbol.replace('USDT', '');
                const isSelected = symbol.toUpperCase() === sym;
                return (
                  <button key={t.symbol} onClick={() => setSymbol(sym)}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors flex items-center gap-1 ${isSelected ? 'border-accent text-accent bg-accent/10' : 'border-border text-gray-400 hover:border-gray-500'}`}>
                    {sym}
                    <span className={t.change24h >= 0 ? 'text-up' : 'text-down'}>
                      {t.change24h >= 0 ? '+' : ''}{t.change24h.toFixed(1)}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <span className="text-xs text-gray-500 self-center">빠른 선택 (대시보드 방문 후 갱신됩니다):</span>
            {['PEPE', 'SHIB', 'DOGE', 'BONK', 'WIF'].map(s => (
              <button key={s} onClick={() => setSymbol(s)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${symbol.toUpperCase() === s ? 'border-accent text-accent' : 'border-border text-gray-400 hover:border-gray-500'}`}>
                {s}
              </button>
            ))}
          </div>
        )}

        <button onClick={handleRun} disabled={backtesting || !symbol.trim()}
          className="btn-primary disabled:opacity-50">
          {backtesting ? <><span className="animate-spin inline-block mr-1">⟳</span>백테스트 중...</> : '백테스트 실행'}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-down/10 border border-down/30 rounded-xl text-down text-sm">{error}</div>
      )}

      {/* 결과 */}
      {backtestResult && (
        <>
          {/* 통계 */}
          <div className="card">
            <h2 className="section-title mb-1">
              {backtestResult.symbol} 결과
              <span className="text-gray-500 font-normal ml-2 text-xs">({backtestResult.timeframe}봉)</span>
            </h2>
            <p className="text-xs text-gray-500 mb-5">
              이 전략 조건이 {backtestResult.symbol}에서 과거 {backtestResult.totalTrades}번 발생했고,
              그 중 {backtestResult.winningTrades}번 수익이 났습니다.
            </p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4 text-center">
              {[
                { label: '총 신호',   value: `${backtestResult.totalTrades}회` },
                { label: '승률',      value: `${(backtestResult.winRate * 100).toFixed(1)}%`,
                  color: backtestResult.winRate >= 0.5 ? 'text-up' : 'text-down' },
                { label: '평균 수익', value: `+${backtestResult.avgProfitPct.toFixed(1)}%`, color: 'text-up' },
                { label: '평균 손실', value: `-${backtestResult.avgLossPct.toFixed(1)}%`,   color: 'text-down' },
                { label: '기댓값 EV', value: `${backtestResult.expectedValuePct >= 0 ? '+' : ''}${backtestResult.expectedValuePct.toFixed(2)}%`,
                  color: backtestResult.expectedValuePct >= 0 ? 'text-up' : 'text-down' },
                { label: '최대 낙폭', value: `-${backtestResult.maxDrawdownPct.toFixed(1)}%`, color: 'text-down' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-surface rounded-lg p-3">
                  <div className={`text-xl font-bold num ${color ?? 'text-gray-100'}`}>{value}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            <div className={`mt-5 p-4 rounded-lg border text-sm ${
              backtestResult.expectedValuePct > 0
                ? 'bg-up/8 border-up/25 text-up'
                : 'bg-down/8 border-down/25 text-down'
            }`}>
              <strong>베이지안 해석:</strong>{' '}
              조건 충족 {backtestResult.totalTrades}번 중 {backtestResult.winningTrades}번 수익 ({(backtestResult.winRate * 100).toFixed(1)}% 승률).
              거래당 기대 손익 <span className="font-bold">{backtestResult.expectedValuePct >= 0 ? '+' : ''}{backtestResult.expectedValuePct.toFixed(2)}%</span>.{' '}
              {backtestResult.expectedValuePct > 2 ? '전략 유효. 실거래 가능.'
                : backtestResult.expectedValuePct > 0 ? '소폭 양수. 수수료 감안 후 재검토.'
                : '이 코인에서는 손실 기대. 조건 재조정 필요.'}
            </div>
          </div>

          {/* 에퀴티 커브 */}
          {backtestResult.equityCurve.length > 1 && (
            <div className="card">
              <h2 className="section-title mb-4">에퀴티 커브 (누적 손익 USDT)</h2>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={backtestResult.equityCurve.map(p => ({
                  time: fmtDate(p.time),
                  equity: +p.equity.toFixed(2)
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} />
                  <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2a2d3a', fontSize: 12, fontFamily: 'inherit' }} />
                  <ReferenceLine y={0} stroke="#2a2d3a" />
                  <Line type="monotone" dataKey="equity" stroke="#6366f1" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* 거래 내역 */}
          {backtestResult.trades.length > 0 && (
            <div className="card">
              <h2 className="section-title mb-4">거래 내역 ({backtestResult.trades.length}건)</h2>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card z-10">
                    <tr className="text-gray-500 border-b border-border">
                      {['#','진입일','청산일','진입가','평균진입가','청산가','손익','그리드 추가','종료'].map(h => (
                        <th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {backtestResult.trades.map((t, i) => <TradeRow key={i} trade={t} idx={i} />)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

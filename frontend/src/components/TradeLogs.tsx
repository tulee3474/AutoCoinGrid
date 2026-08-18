import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getPaperLogsPage, getLiveLogsPage, PaperTradeLog, LiveTradeLog } from '../utils/api';
import { fmtDateTime } from '../utils/datetime';

type LogType = 'paper' | 'live';
type AnyLog = PaperTradeLog | LiveTradeLog;

const EXIT_LABEL: Record<string, { text: string; cls: string }> = {
  takeProfit:     { text: '익절',     cls: 'bg-up/15 text-up' },
  stopLoss:       { text: '손절',     cls: 'bg-down/15 text-down' },
  timeout:        { text: '타임아웃', cls: 'bg-border text-gray-400' },
  manual:         { text: '수동청산', cls: 'bg-accent/15 text-accent' },
  signalReversal: { text: 'RSI반전',  cls: 'bg-yellow-500/15 text-yellow-400' },
  rsiOverheat:    { text: 'RSI과열',  cls: 'bg-red-500/15 text-red-400' },
};

const PAGE_SIZE = 50;

export default function TradeLogs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const type = (searchParams.get('type') === 'live' ? 'live' : 'paper') as LogType;

  const [logs, setLogs]           = useState<AnyLog[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [strategyNames, setStrategyNames] = useState<string[]>([]);
  const [strategyFilter, setStrategyFilter] = useState('');
  const [loading, setLoading]     = useState(true);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async (p: number, t: LogType, strategy: string) => {
    setLoading(true);
    try {
      const fetcher = t === 'paper' ? getPaperLogsPage : getLiveLogsPage;
      const data = await fetcher(p, PAGE_SIZE, strategy || undefined);
      setLogs(data.logs);
      setTotal(data.total);
      setStrategyNames(data.strategyNames);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPage(1);
    load(1, type, strategyFilter);
  }, [type, strategyFilter, load]);

  useEffect(() => {
    load(page, type, strategyFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const setType = (t: LogType) => setSearchParams(t === 'paper' ? {} : { type: t });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-gray-100">전체 거래 로그</h1>
        <p className="text-xs text-gray-500 mt-0.5">가상 지갑·실제 거래의 전체 체결 이력을 검색합니다</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border overflow-hidden">
          <button
            onClick={() => setType('paper')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors ${type === 'paper' ? 'bg-accent/15 text-accent' : 'text-gray-500 hover:text-gray-300'}`}
          >
            가상 지갑
          </button>
          <button
            onClick={() => setType('live')}
            className={`px-4 py-1.5 text-sm font-medium transition-colors border-l border-border ${type === 'live' ? 'bg-accent/15 text-accent' : 'text-gray-500 hover:text-gray-300'}`}
          >
            실제 거래
          </button>
        </div>

        <select
          value={strategyFilter}
          onChange={e => setStrategyFilter(e.target.value)}
          className="text-sm bg-card border border-border rounded-lg px-3 py-1.5 text-gray-300"
        >
          <option value="">전체 전략</option>
          {strategyNames.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <span className="text-xs text-gray-500 ml-auto">총 {total.toLocaleString()}건</span>
      </div>

      <div className="card overflow-x-auto">
        {loading ? (
          <p className="text-gray-500 text-sm text-center py-10">불러오는 중...</p>
        ) : logs.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-10">거래 기록 없음</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-border">
                {['코인', '', '전략', '진입가', '청산가', '손익', '사유', '진입시각', '청산시각'].map(h => (
                  <th key={h} className="text-left pb-2 pr-3 pt-1 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(log => {
                const exit = EXIT_LABEL[log.exitReason] ?? { text: log.exitReason, cls: 'bg-border text-gray-400' };
                return (
                  <tr key={log.id} className="border-b border-border/40 hover:bg-white/3">
                    <td className="py-2 pr-3 font-semibold text-gray-200 whitespace-nowrap">{log.symbol.replace('USDT', '')}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-[10px] px-1 py-0.5 rounded ${(log.side ?? 'SHORT') === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                        {(log.side ?? 'SHORT') === 'LONG' ? '롱' : '숏'}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-gray-500 truncate max-w-[140px]" title={log.strategyName}>{log.strategyName}</td>
                    <td className="py-2 pr-3 text-gray-400 num whitespace-nowrap">${log.entryPrice.toPrecision(4)}</td>
                    <td className="py-2 pr-3 text-gray-400 num whitespace-nowrap">${log.exitPrice.toPrecision(4)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`font-bold num ${log.pnlUsdt >= 0 ? 'text-up' : 'text-down'}`}>
                        {log.pnlUsdt >= 0 ? '+' : ''}{log.pnlPct.toFixed(2)}%
                      </span>
                      <span className="text-gray-500 num ml-1">
                        ({log.pnlUsdt >= 0 ? '+' : ''}${log.pnlUsdt.toFixed(2)})
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${exit.cls}`}>{exit.text}</span>
                    </td>
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{fmtDateTime(log.entryTime)}</td>
                    <td className="py-2 pr-3 text-gray-500 whitespace-nowrap">{fmtDateTime(log.exitTime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="text-xs px-3 py-1.5 rounded border border-border text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ← 이전
          </button>
          <span className="text-xs text-gray-500">{page} / {totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="text-xs px-3 py-1.5 rounded border border-border text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            다음 →
          </button>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  getLiveStatus, startLiveScanner, stopLiveScanner, forceStopLiveScanner,
  getLivePositions, getLiveLogs, getLiveScanLog, getLiveStats, getLiveStrategyStats,
  getLiveAccount, closeLivePosition, clearLiveLogs, getStrategies, toggleStrategy, deleteStrategy, getMe,
  LivePosition, LiveTradeLog, ScanLogEntry, LiveAccountInfo
} from '../utils/api';
import { StrategyConfig, Side } from '../types';
import { fmtDateTime, fmtTime } from '../utils/datetime';

const EXIT_LABEL: Record<string, { text: string; cls: string }> = {
  takeProfit:     { text: '익절',    cls: 'bg-up/15 text-up' },
  stopLoss:       { text: '손절',    cls: 'bg-down/15 text-down' },
  timeout:        { text: '타임아웃', cls: 'bg-border text-gray-400' },
  manual:         { text: '수동청산', cls: 'bg-accent/15 text-accent' },
  signalReversal: { text: 'RSI반전', cls: 'bg-yellow-500/15 text-yellow-400' },
  rsiOverheat:    { text: 'RSI과열', cls: 'bg-red-500/15 text-red-400' },
};

function StatCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="card text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold num ${valueClass ?? 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

const fmtDt = fmtDateTime;

const REFRESH_SEC = 10;
const MANUAL_REFRESH_COOLDOWN_SEC = 5;

function ScanLogLine({ entry }: { entry: ScanLogEntry }) {
  const cls = { info: 'text-gray-400', signal: 'text-up', close: 'text-accent', error: 'text-down' }[entry.type];
  return (
    <div className={`text-xs font-mono ${cls} py-0.5`}>
      <span className="text-gray-600 mr-2">{fmtTime(entry.time)}</span>
      {entry.message}
    </div>
  );
}

export default function LiveTrading() {
  const [status, setStatus]               = useState<{ running: boolean; stopping: boolean; openCount: number; totalTrades: number } | null>(null);
  const [stats, setStats]                 = useState<{ totalTrades: number; totalPnlUsdt: number; winRate: number } | null>(null);
  const [strategyStats, setStrategyStats] = useState<Record<string, { winRate: number; trades: number }>>({});
  const [positions, setPositions]         = useState<LivePosition[]>([]);
  const [logs, setLogs]                   = useState<LiveTradeLog[]>([]);
  const [scanLog, setScanLog]             = useState<ScanLogEntry[]>([]);
  const [strategies, setStrategies]       = useState<StrategyConfig[]>([]);
  const [hasApiKeys, setHasApiKeys]       = useState<boolean | null>(null);
  const [account, setAccount]             = useState<LiveAccountInfo | null>(null);
  const [accountError, setAccountError]   = useState<string | null>(null);
  const [accountDiag, setAccountDiag]     = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading]             = useState(true);
  const [stopping, setStopping]           = useState(false);
  const [clearingLogs, setClearingLogs]   = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(Date.now());
  const [lastManualAt, setLastManualAt]   = useState(0);
  const [, setTick]                       = useState(0);

  const refresh = useCallback(async () => {
    const [st, pos, lg, sl, me, liveStats, ss, acct] = await Promise.allSettled([
      getLiveStatus(),
      getLivePositions(),
      getLiveLogs(50),
      getLiveScanLog(),
      getMe(),
      getLiveStats(),
      getLiveStrategyStats(),
      getLiveAccount(),
    ]);
    if (st.status        === 'fulfilled') setStatus(st.value);
    if (pos.status       === 'fulfilled') setPositions(pos.value);
    if (lg.status        === 'fulfilled') setLogs(lg.value);
    if (sl.status        === 'fulfilled') setScanLog(sl.value);
    if (me.status        === 'fulfilled') setHasApiKeys(me.value.hasApiKeys);
    if (liveStats.status === 'fulfilled') setStats(liveStats.value);
    if (ss.status        === 'fulfilled') setStrategyStats(ss.value);
    if (acct.status === 'fulfilled') {
      setAccount(acct.value);
      setAccountError(null);
      setAccountDiag(null);
    } else {
      const err = (acct as PromiseRejectedResult).reason;
      setAccountError(err?.response?.data?.error ?? err?.message ?? '잔고 조회 실패');
      setAccountDiag(err?.response?.data?.diag ?? null);
    }
    setLoading(false);
    setLastRefreshAt(Date.now());
  }, []);

  const refreshStrategies = useCallback(async () => {
    try { setStrategies(await getStrategies()); } catch {}
  }, []);

  useEffect(() => {
    refresh();
    refreshStrategies();
    const id = setInterval(refresh, REFRESH_SEC * 1000);
    return () => clearInterval(id);
  }, [refresh, refreshStrategies]);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useWebSocket((data) => {
    if (['live_signal', 'live_close', 'live_stopped', 'live_status'].includes(data.type)) {
      refresh();
    }
  });

  const secondsUntilRefresh = Math.max(0, REFRESH_SEC - Math.floor((Date.now() - lastRefreshAt) / 1000));
  const manualCooldownLeft  = Math.max(0, MANUAL_REFRESH_COOLDOWN_SEC - Math.floor((Date.now() - lastManualAt) / 1000));

  const handleManualRefresh = () => {
    if (manualCooldownLeft > 0) return;
    setLastManualAt(Date.now());
    refresh();
  };

  const handleStart = async () => {
    await startLiveScanner();
    await refresh();
  };

  const handleStop = async () => {
    const monitoringCount = positions.filter(p => p.tpOrderId === null).length;
    if (monitoringCount > 0) {
      if (!confirm(`스캐너 모니터링 포지션 ${monitoringCount}개는 스캐너가 꺼지면 자동 관리가 불가능해 즉시 시장가 청산됩니다.\n계속하시겠습니까?`)) return;
    }
    await stopLiveScanner();
    await refresh();
  };

  const handleForceStop = async () => {
    if (!confirm('모든 포지션을 즉시 시장가 청산하고 스캐너를 중지합니다. 계속하시겠습니까?')) return;
    setStopping(true);
    try {
      await forceStopLiveScanner();
      await refresh();
    } finally {
      setStopping(false);
    }
  };

  const handleClose = async (symbol: string, side: Side) => {
    if (!confirm(`${symbol} 포지션을 시장가로 즉시 청산합니까?`)) return;
    await closeLivePosition(symbol, side);
    await refresh();
  };

  const handleToggleStrategy = async (id: string) => {
    const updated = await toggleStrategy(id);
    setStrategies(prev => prev.map(s => s.id === id ? updated : s));
  };

  const handleDeleteStrategy = async (id: string, name: string) => {
    if (!confirm(`"${name}" 전략을 삭제하시겠습니까?`)) return;
    await deleteStrategy(id);
    setStrategies(prev => prev.filter(s => s.id !== id));
  };

  const handleClearLogs = async () => {
    if (!confirm('거래 로그와 실현 손익을 모두 초기화합니까? (오픈 포지션은 유지됩니다)')) return;
    setClearingLogs(true);
    try {
      await clearLiveLogs();
      await refresh();
    } finally {
      setClearingLogs(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const isRunning  = status?.running  ?? false;
  const isStopping = status?.stopping ?? false;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* 헤더 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="page-title">실제 거래 (Live Trading)</h1>
          <p className="page-sub">개인 Binance API 키로 실제 자금을 사용하는 자동매매입니다</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isRunning && (
            <button
              onClick={handleForceStop}
              disabled={stopping}
              className="text-sm px-3 py-2 rounded-lg font-medium border border-down/40 text-down hover:bg-down/10 transition-colors disabled:opacity-50"
            >
              {stopping ? '청산 중...' : '⚡ 즉시 중지'}
            </button>
          )}
          <button
            onClick={isRunning ? handleStop : handleStart}
            disabled={!hasApiKeys}
            className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isRunning
                ? 'bg-warn/20 text-warn border border-warn/30 hover:bg-warn/30'
                : 'bg-up/20 text-up border border-up/30 hover:bg-up/30'
            }`}
          >
            {isRunning ? (isStopping ? '⏸ 중지 예정' : '⏹ 스캐너 중지') : '▶ 스캐너 시작'}
          </button>
        </div>
      </div>

      {/* API 키 미등록 경고 */}
      {hasApiKeys === false && (
        <div className="p-4 rounded-xl border border-down/40 bg-down/5 text-sm">
          <p className="text-down font-semibold mb-1">⚠ Binance API 키가 등록되지 않았습니다</p>
          <p className="text-gray-400 text-xs">
            실제 거래를 하려면 내 정보에서 Binance API 키와 시크릿을 먼저 등록해야 합니다.
          </p>
        </div>
      )}

      {/* 실거래 위험 안내 */}
      <div className="p-3 rounded-xl border border-down/30 bg-down/5 text-xs text-down/80 space-y-1">
        <p className="font-semibold text-down">⚠ 실제 자금 사용 — 주의사항</p>
        <p>· TP/SL 주문은 Binance에 직접 등록되며 서버가 꺼져도 체결됩니다 (<span className="text-yellow-400">스캐너 모니터링</span> 표기 코인은 서버가 켜져 있어야 청산됩니다)</p>
        <p>· 즉시 중지는 모든 포지션을 시장가로 청산합니다 — 슬리피지 발생 가능</p>
        <p>· 일반 중지는 기존 포지션 모두 정리 후 자동으로 멈춥니다</p>
      </div>

      {/* 스캐너 상태 배너 */}
      <div className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${
        isRunning && !isStopping ? 'bg-up/5 border-up/20 text-up'
        : isStopping             ? 'bg-warn/5 border-warn/20 text-warn'
        :                          'bg-border/30 border-border text-gray-500'
      }`}>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          isRunning && !isStopping ? 'bg-up animate-pulse'
          : isStopping             ? 'bg-warn animate-pulse'
          :                          'bg-gray-600'
        }`} />
        {isRunning && !isStopping
          ? '실거래 스캐너 실행 중 — 1분마다 전체 알트코인 스캔 후 조건 충족 시 실제 숏 진입합니다'
          : isStopping
          ? `중지 예정 — 잔여 포지션 ${status?.openCount}개 청산 완료 후 자동 중지됩니다`
          : '스캐너 중지됨 — 위 버튼으로 시작하세요. 전략을 먼저 활성화해야 신호가 발생합니다'}
      </div>

      {/* Binance 선물 지갑 현황 */}
      {hasApiKeys && (
        <div className="card">
          <h2 className="section-title mb-3">Binance 선물 지갑</h2>
          {account ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: '총 자산 (마진 잔고)', value: `$${account.totalMarginBalance.toFixed(2)}`,    cls: 'text-gray-100' },
                { label: '지갑 잔고',           value: `$${account.totalWalletBalance.toFixed(2)}`,    cls: 'text-gray-300' },
                { label: '가용 잔고',           value: `$${account.availableBalance.toFixed(2)}`,      cls: account.availableBalance > 0 ? 'text-up' : 'text-gray-400' },
                { label: '미실현 손익',         value: `${account.totalUnrealizedProfit >= 0 ? '+' : ''}$${account.totalUnrealizedProfit.toFixed(2)}`, cls: account.totalUnrealizedProfit >= 0 ? 'text-up' : 'text-down' },
              ].map(({ label, value, cls }) => (
                <div key={label} className="bg-surface rounded-lg p-3 text-center">
                  <div className="text-xs text-gray-500 mb-1">{label}</div>
                  <div className={`text-lg font-bold num ${cls}`}>{value}</div>
                </div>
              ))}
            </div>
          ) : accountError ? (
            <div className="text-xs text-down bg-down/5 border border-down/20 rounded-lg px-3 py-2 space-y-1">
              <div>⚠ 잔고 조회 실패: {accountError}</div>
              {accountDiag && (
                <div className="text-gray-500 font-mono text-[10px] leading-relaxed mt-1">
                  {Object.entries(accountDiag).map(([k, v]) => (
                    <div key={k}>{k}: {String(v ?? 'null')}</div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-500 text-center py-3">잔고 조회 중...</div>
          )}
        </div>
      )}

      {/* 전략 목록 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="section-title">전략 목록</h2>
            <p className="text-xs text-gray-500 mt-0.5">활성화된 전략이 자동 스캔에 사용됩니다</p>
          </div>
          <Link to="/strategy" className="text-xs text-accent hover:underline">+ 새 전략 추가</Link>
        </div>
        {strategies.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-gray-500 text-sm">저장된 전략 없음</p>
            <Link to="/strategy" className="text-xs text-accent hover:underline mt-1 block">
              전략 설정 페이지에서 전략을 만들고 저장하세요 →
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {strategies.map(s => (
              <div key={s.id} className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                s.enabled ? 'border-up/25 bg-up/5' : 'border-border bg-surface'
              }`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.enabled ? 'bg-up animate-pulse' : 'bg-gray-600'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${(s.side ?? 'SHORT') === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                      {(s.side ?? 'SHORT') === 'LONG' ? '롱' : '숏'}
                    </span>
                    <span className="text-sm font-medium text-gray-200 truncate">{s.name}</span>
                    {s.enabled && <span className="text-xs text-up font-semibold">● 활성</span>}
                    {(() => {
                      const st = strategyStats[s.name];
                      if (!st || st.trades === 0) return null;
                      const wr = st.winRate * 100;
                      return (
                        <span className={`text-xs font-semibold ${wr >= 50 ? 'text-up' : 'text-down'}`}>
                          승률 {wr.toFixed(1)}% ({st.trades}건)
                        </span>
                      );
                    })()}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    RSI {s.conditions.rsi.min}~{s.conditions.rsi.max} ·{' '}
                    24h +{s.conditions.priceChange24h.min}% 이상 ·{' '}
                    레버리지 {s.trade.leverage}x · 진입 ${s.trade.entryAmountUsdt}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleToggleStrategy(s.id)}
                    className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                      s.enabled
                        ? 'border-down/30 text-down hover:bg-down/10'
                        : 'border-up/30 text-up hover:bg-up/10'
                    }`}
                  >
                    {s.enabled ? '중지' : '시작'}
                  </button>
                  <Link
                    to={`/strategy?edit=${s.id}`}
                    className="text-xs px-2 py-1.5 rounded-lg border border-border text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
                  >
                    수정
                  </Link>
                  <button
                    onClick={() => handleDeleteStrategy(s.id, s.name)}
                    className="text-xs px-2 py-1.5 rounded-lg border border-border text-gray-500 hover:text-down hover:border-down/30 transition-colors"
                  >
                    삭제
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 통계 */}
      {(() => {
        const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.pnlUsdt, 0);
        return (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard label="오픈 포지션" value={`${status?.openCount ?? 0}개`} />
            <StatCard label="총 체결 거래" value={`${stats?.totalTrades ?? 0}건`} />
            <StatCard
              label="미실현 손익"
              value={`${totalUnrealizedPnl >= 0 ? '+' : ''}$${totalUnrealizedPnl.toFixed(2)}`}
              sub={`포지션 ${positions.length}개`}
              valueClass={totalUnrealizedPnl >= 0 ? 'text-up' : 'text-down'}
            />
            <StatCard
              label="실현 손익 (전체)"
              value={`${(stats?.totalPnlUsdt ?? 0) >= 0 ? '+' : ''}$${(stats?.totalPnlUsdt ?? 0).toFixed(2)}`}
              valueClass={(stats?.totalPnlUsdt ?? 0) >= 0 ? 'text-up' : 'text-down'}
            />
            <StatCard
              label="승률 (전체)"
              value={stats == null || stats.totalTrades === 0 ? '-' : `${(stats.winRate * 100).toFixed(1)}%`}
              sub="연속 SL 묶음 기준"
              valueClass={stats && stats.winRate >= 0.5 ? 'text-up' : 'text-gray-400'}
            />
          </div>
        );
      })()}

      {/* 오픈 포지션 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h2 className="section-title">
            오픈 포지션
            <span className="text-gray-500 font-normal ml-2 text-xs">({positions.length}개)</span>
          </h2>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>시세 {secondsUntilRefresh}초 후 갱신</span>
            <button
              onClick={handleManualRefresh}
              disabled={manualCooldownLeft > 0}
              className="px-2 py-1 rounded border border-border text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {manualCooldownLeft > 0 ? `${manualCooldownLeft}초 후 가능` : '↻ 새로고침'}
            </button>
          </div>
        </div>
        {positions.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-6">
            오픈 포지션 없음 — 스캐너가 조건 충족 코인을 발견하면 자동 진입됩니다
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-border">
                  {['코인', '', '전략', '진입가', '현재가', '미실현손익', 'TP', 'SL', '만료', ''].map(h => (
                    <th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map(pos => {
                  const expiresAt = new Date(pos.expiresAt);
                  const remaining = expiresAt.getTime() - Date.now();
                  const hoursLeft = Math.max(0, Math.floor(remaining / 3_600_000));
                  const isMonitored = pos.tpOrderId === null; // 바이낸스 주문 미지원, 스캐너 가격 모니터링
                  return (
                    <tr key={pos.id} className={`border-b border-border/40 hover:bg-white/3 ${isMonitored ? 'bg-yellow-500/3' : ''}`}>
                      <td className="py-2 pr-3">
                        <div className="font-bold text-gray-200">{pos.symbol.replace('USDT', '')}</div>
                        {isMonitored && (
                          <div
                            className="text-[10px] text-yellow-400/80 leading-tight mt-0.5"
                            title="이 코인은 바이낸스 조건부 주문(TP/SL)을 지원하지 않아 스캐너가 60초마다 가격을 확인해 청산합니다. 서버가 꺼지면 자동 청산이 중단됩니다."
                          >
                            스캐너 모니터링
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span className={`text-[10px] px-1 py-0.5 rounded ${pos.side === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                          {pos.side === 'LONG' ? '롱' : '숏'}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-gray-500 truncate max-w-[80px]">{pos.strategyName}</td>
                      <td className="py-2 pr-3 text-gray-400 num" title={pos.gridPrices.length > 0 ? `최초 진입가 $${pos.entryPrice.toPrecision(5)} · 그리드 ${pos.gridsFilled}/${pos.gridPrices.length}차 (청산가 안전마진 내 등록 가능한 최대치)` : undefined}>
                        ${(pos.avgEntryPrice > 0 ? pos.avgEntryPrice : pos.entryPrice).toPrecision(5)}
                        {pos.gridPrices.length > 0 && <span className="text-gray-600 ml-0.5">({pos.gridsFilled}/{pos.gridPrices.length}차)</span>}
                        {pos.gridsFilled < pos.gridPrices.length && (
                          <div className="text-[10px] text-gray-600">다음 그리드 ${pos.gridPrices[pos.gridsFilled].toPrecision(4)}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-gray-300 num">${pos.currentPrice.toPrecision(5)}</td>
                      <td className="py-2 pr-3">
                        <span className={`font-bold num ${pos.pnlUsdt >= 0 ? 'text-up' : 'text-down'}`}>
                          {pos.pnlUsdt >= 0 ? '+' : ''}{pos.pnlPct.toFixed(2)}%
                          <span className="font-normal opacity-70">({pos.pnlUsdt >= 0 ? '+' : ''}{(pos.pnlPct / pos.leverage).toFixed(2)}%)</span>
                        </span>
                        <span className="ml-1 text-gray-500 num">
                          ({pos.pnlUsdt >= 0 ? '+' : ''}${pos.pnlUsdt.toFixed(2)})
                        </span>
                      </td>
                      <td className="py-2 pr-3 num">
                        <span className={isMonitored ? 'text-yellow-400' : 'text-up'}>${pos.takeProfitPrice.toPrecision(4)}</span>
                      </td>
                      <td className="py-2 pr-3 num" title={pos.liquidationPrice ? `실제 청산가 $${pos.liquidationPrice.toPrecision(5)}` : undefined}>
                        <span className={isMonitored ? 'text-yellow-400' : 'text-down'}>${pos.stopLossPrice.toPrecision(4)}</span>
                        {pos.liquidationPrice != null && (() => {
                          const avgEntry = pos.avgEntryPrice > 0 ? pos.avgEntryPrice : pos.entryPrice;
                          const liqPct = ((pos.liquidationPrice - avgEntry) / avgEntry) * 100;
                          return (
                            <div className="text-[10px] text-gray-600">청산 ${pos.liquidationPrice.toPrecision(4)} ({liqPct >= 0 ? '+' : ''}{liqPct.toFixed(1)}%)</div>
                          );
                        })()}
                      </td>
                      <td className={`py-2 pr-3 num ${hoursLeft < 2 ? 'text-warn' : 'text-gray-500'}`}>
                        {hoursLeft}h 후
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => handleClose(pos.symbol, pos.side as Side)}
                          className="text-xs px-2 py-1 rounded border border-border text-gray-400 hover:text-down hover:border-down transition-colors"
                        >
                          청산
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 거래 로그 */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="section-title">
              거래 로그
              <span className="text-gray-500 font-normal ml-2 text-xs">최근 50건</span>
            </h2>
            <button
              onClick={handleClearLogs}
              disabled={clearingLogs || logs.length === 0}
              className="text-xs px-2 py-1 rounded border border-border text-gray-500 hover:text-down hover:border-down/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {clearingLogs ? '삭제 중...' : '로그 초기화'}
            </button>
          </div>
          {logs.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-6">거래 없음</p>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {logs.map(log => {
                const exit = EXIT_LABEL[log.exitReason];
                const expanded = expandedLogId === log.id;
                return (
                  <div
                    key={log.id}
                    className="text-xs bg-surface rounded-lg overflow-hidden cursor-pointer hover:bg-white/5 transition-colors"
                    onClick={() => setExpandedLogId(expanded ? null : log.id)}
                  >
                    <div className="flex items-center gap-2 p-2">
                      <span className="text-gray-300 font-semibold w-12 flex-shrink-0">{log.symbol.replace('USDT', '')}</span>
                      <span className={`text-[10px] px-1 py-0.5 rounded flex-shrink-0 ${log.side === 'LONG' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                        {log.side === 'LONG' ? '롱' : '숏'}
                      </span>
                      <span className="text-gray-600 truncate w-16 flex-shrink-0" title={log.strategyName}>{log.strategyName}</span>
                      <span className={`font-bold num flex-1 ${log.pnlUsdt >= 0 ? 'text-up' : 'text-down'}`}>
                        {log.pnlUsdt >= 0 ? '+' : ''}{log.pnlPct.toFixed(2)}%
                        <span className="font-normal opacity-70">({log.pnlUsdt >= 0 ? '+' : ''}{(log.pnlPct / log.leverage).toFixed(2)}%)</span>
                        <span className="text-gray-500 font-normal ml-1">(${log.pnlUsdt.toFixed(2)})</span>
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${exit.cls}`}>
                        {exit.text}
                      </span>
                    </div>
                    {expanded && (
                      <div className="px-2 pb-2 pt-0 text-gray-500 border-t border-border/40 space-y-0.5">
                        <div>진입: <span className="text-gray-300 num">${log.entryPrice.toPrecision(4)}</span> @ <span className="text-gray-300">{fmtDt(log.entryTime)}</span></div>
                        <div>청산: <span className="text-gray-300 num">${log.exitPrice.toPrecision(4)}</span> @ <span className="text-gray-300">{fmtDt(log.exitTime)}</span></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 스캔 로그 */}
        <div className="card">
          <h2 className="section-title mb-4">
            스캔 로그
            <span className="text-gray-500 font-normal ml-2 text-xs">실시간 이벤트</span>
          </h2>
          {scanLog.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-6">스캐너를 시작하면 로그가 표시됩니다</p>
          ) : (
            <div className="space-y-0.5 max-h-80 overflow-y-auto bg-surface rounded-lg p-3">
              {scanLog.map((entry, i) => <ScanLogLine key={i} entry={entry} />)}
            </div>
          )}
        </div>
      </div>

      {/* 안내 */}
      <div className="card border-warn/20 bg-warn/5 text-xs text-gray-400 space-y-1.5">
        <p className="text-warn font-semibold text-sm mb-2">실제 거래 동작 방식</p>
        <p>1. <strong className="text-gray-300">전략 활성화</strong> → 스캐너 시작 → 조건 충족 코인 자동 숏 진입</p>
        <p>2. 진입 시 Binance에 <strong className="text-gray-300">TP·SL 주문이 직접 등록</strong>됩니다 (서버 꺼도 체결됨)</p>
        <p>3. 스캐너는 10초~1분마다 Binance 주문 체결 여부를 확인하고 DB를 업데이트합니다</p>
        <p>4. 서버 재시작 후에도 DB의 포지션이 유지되므로 <strong className="text-gray-300">스캐너만 다시 시작</strong>하면 됩니다</p>
        <p>5. <strong className="text-gray-300">즉시 중지</strong>: 모든 포지션 시장가 청산 후 종료 · <strong className="text-gray-300">일반 중지</strong>: 신규 진입 중단, 기존 포지션 정리 후 종료</p>
      </div>
    </div>
  );
}

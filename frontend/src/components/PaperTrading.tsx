import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  getPaperWallet, getPaperPositions, getPaperLogs,
  resetPaperWallet, closePaperPosition, clearPaperLogs,
  getPaperScannerStatus, startPaperScanner, stopPaperScanner,
  getStrategies, toggleStrategy, deleteStrategy, getPaperStrategyStats
} from '../utils/api';
import { StrategyConfig } from '../types';
import { fmtDate, fmtDateTime, fmtTime } from '../utils/datetime';

interface WalletSummary {
  balance: number;
  initialBalance: number;
  openPositionsCount: number;
  totalTradesCount: number;
  realizedPnlUsdt: number;
  unrealizedPnlUsdt: number;
  totalEquity: number;
  winRate: number;
}

interface PaperPosition {
  id: string;
  symbol: string;
  entryPrice: number;
  avgEntryPrice: number;
  gridsFilled: number;
  currentPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryAmountUsdt: number;
  leverage: number;
  openedAt: number;
  expiresAt: number;
  pnlPct: number;
  pnlUsdt: number;
  strategyName: string;
}

interface TradeLog {
  id: string;
  symbol: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsdt: number;
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual' | 'signalReversal' | 'rsiOverheat';
  entryAmountUsdt: number;
  leverage: number;
  strategyName: string;
}

interface ScanLog {
  time: number;
  message: string;
  type: 'info' | 'signal' | 'close' | 'error';
}

const EXIT_LABEL: Record<string, { text: string; cls: string }> = {
  takeProfit:      { text: '익절',    cls: 'bg-up/15 text-up' },
  stopLoss:        { text: '손절',    cls: 'bg-down/15 text-down' },
  timeout:         { text: '타임아웃', cls: 'bg-border text-gray-400' },
  manual:          { text: '수동청산', cls: 'bg-accent/15 text-accent' },
  signalReversal:  { text: 'RSI반전', cls: 'bg-yellow-500/15 text-yellow-400' },
  rsiOverheat:     { text: 'RSI과열', cls: 'bg-red-500/15 text-red-400' },
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

function ScanLogLine({ entry }: { entry: ScanLog }) {
  const cls = {
    info:   'text-gray-400',
    signal: 'text-up',
    close:  'text-accent',
    error:  'text-down',
  }[entry.type];
  return (
    <div className={`text-xs font-mono ${cls} py-0.5`}>
      <span className="text-gray-600 mr-2">{fmtTime(entry.time)}</span>
      {entry.message}
    </div>
  );
}

const fmtDt = fmtDateTime;

const REFRESH_SEC = 10;
const MANUAL_REFRESH_COOLDOWN_SEC = 5;

export default function PaperTrading() {
  const [wallet, setWallet]               = useState<WalletSummary | null>(null);
  const [positions, setPositions]         = useState<PaperPosition[]>([]);
  const [logs, setLogs]                   = useState<TradeLog[]>([]);
  const [scanLog, setScanLog]             = useState<ScanLog[]>([]);
  const [scannerOn, setScannerOn]         = useState(false);
  const [strategies, setStrategies]       = useState<StrategyConfig[]>([]);
  const [strategyStats, setStrategyStats] = useState<Record<string, { winRate: number; trades: number }>>({});
  const [loading, setLoading]             = useState(true);
  const [resetting, setResetting]         = useState(false);
  const [clearingLogs, setClearingLogs]   = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState(Date.now());
  const [lastManualAt, setLastManualAt]   = useState(0);
  const [, setTick]                       = useState(0);

  const refreshStrategies = useCallback(async () => {
    try { setStrategies(await getStrategies()); } catch {}
  }, []);

  const refresh = useCallback(async () => {
    const [w, p, l, s, ss] = await Promise.allSettled([
      getPaperWallet(),
      getPaperPositions(),
      getPaperLogs(50),
      getPaperScannerStatus(),
      getPaperStrategyStats(),
    ]);
    if (w.status  === 'fulfilled') setWallet(w.value);
    if (p.status  === 'fulfilled') setPositions(p.value);
    if (l.status  === 'fulfilled') setLogs(l.value);
    if (s.status  === 'fulfilled') {
      setScannerOn(s.value.running);
      setScanLog(s.value.log ?? []);
    }
    if (ss.status === 'fulfilled') setStrategyStats(ss.value);
    setLoading(false);
    setLastRefreshAt(Date.now());
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
    if (['paper_signal', 'paper_close', 'paper_grid_fill'].includes(data.type)) {
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

  const handleReset = async () => {
    if (!confirm('가상 지갑을 $10,000 USDT로 초기화하겠습니까? 모든 기록이 삭제됩니다.')) return;
    setResetting(true);
    try {
      await resetPaperWallet();
      await refresh();
    } finally {
      setResetting(false);
    }
  };

  const handleToggleScanner = async () => {
    if (scannerOn) {
      await stopPaperScanner();
    } else {
      await startPaperScanner();
    }
    await refresh();
  };

  const handleClose = async (id: string) => {
    if (!confirm('이 포지션을 현재가로 청산하겠습니까?')) return;
    await closePaperPosition(id);
    await refresh();
  };

  const handleClearLogs = async () => {
    if (!confirm('거래 로그와 실현 손익을 모두 초기화합니까? (잔고·포지션은 유지됩니다)')) return;
    setClearingLogs(true);
    try {
      await clearPaperLogs();
      await refresh();
    } finally {
      setClearingLogs(false);
    }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const pnlDiff = wallet ? wallet.totalEquity - wallet.initialBalance : 0;
  const pnlPct  = wallet ? (pnlDiff / wallet.initialBalance) * 100 : 0;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* 헤더 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="page-title">가상 지갑 (Paper Trading)</h1>
          <p className="page-sub">실제 자금 없이 전략을 실시간 테스트합니다 — 초기 잔고 $10,000 USDT</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <button
            onClick={handleToggleScanner}
            className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors ${
              scannerOn
                ? 'bg-down/20 text-down border border-down/30 hover:bg-down/30'
                : 'bg-up/20 text-up border border-up/30 hover:bg-up/30'
            }`}
          >
            {scannerOn ? '⏹ 스캐너 중지' : '▶ 스캐너 시작'}
          </button>
          <button
            onClick={handleReset}
            disabled={resetting}
            className="text-sm px-3 py-2 rounded-lg border border-border text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors disabled:opacity-50"
          >
            초기화
          </button>
        </div>
      </div>

      {/* 스캐너 상태 배너 */}
      <div className={`flex items-center gap-3 p-3 rounded-xl border text-sm ${
        scannerOn
          ? 'bg-up/5 border-up/20 text-up'
          : 'bg-border/30 border-border text-gray-500'
      }`}>
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${scannerOn ? 'bg-up animate-pulse' : 'bg-gray-600'}`} />
        {scannerOn
          ? '자동 스캐너 실행 중 — 1분마다 전체 알트코인 스캔 후 조건 충족 시 자동 가상 진입합니다'
          : '스캐너 중지됨 — 위 버튼으로 시작하세요. 전략 설정에서 전략을 활성화해야 신호가 발생합니다'}
      </div>

      {/* 전략 관리 */}
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
                    <span className="text-sm font-medium text-gray-200 truncate">{s.name}</span>
                    {s.enabled && <span className="text-xs text-up font-semibold">● 실행 중</span>}
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
                    볼륨 {s.conditions.volumeMultiplier.min}x 이상 ·{' '}
                    {s.conditions.rsi.timeframe}봉 ·{' '}
                    레버리지 {s.trade.leverage}x
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

      {/* 자산 요약 */}
      {wallet && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            label="총 자산 (Equity)"
            value={`$${wallet.totalEquity.toFixed(2)}`}
            sub={`${pnlDiff >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`}
            valueClass={pnlDiff >= 0 ? 'text-up' : 'text-down'}
          />
          <StatCard
            label="가용 잔고"
            value={`$${wallet.balance.toFixed(2)}`}
            sub="포지션 담보 차감 후"
          />
          <StatCard
            label="미실현 손익"
            value={`${wallet.unrealizedPnlUsdt >= 0 ? '+' : ''}$${wallet.unrealizedPnlUsdt.toFixed(2)}`}
            sub={`포지션 ${wallet.openPositionsCount}개`}
            valueClass={wallet.unrealizedPnlUsdt >= 0 ? 'text-up' : 'text-down'}
          />
          <StatCard
            label="실현 손익"
            value={`${wallet.realizedPnlUsdt >= 0 ? '+' : ''}$${wallet.realizedPnlUsdt.toFixed(2)}`}
            sub={`총 ${wallet.totalTradesCount}건`}
            valueClass={wallet.realizedPnlUsdt >= 0 ? 'text-up' : 'text-down'}
          />
          <StatCard
            label="승률"
            value={`${(wallet.winRate * 100).toFixed(1)}%`}
            sub={`${wallet.openPositionsCount}개 포지션 오픈 중`}
            valueClass={wallet.winRate >= 0.5 ? 'text-up' : 'text-gray-400'}
          />
        </div>
      )}

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
                  {['코인', '전략', '진입가', '현재가', '미실현손익', 'TP', 'SL', '만료', ''].map(h => (
                    <th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map(pos => (
                  <tr key={pos.id} className="border-b border-border/40 hover:bg-white/3">
                    <td className="py-2 pr-3 font-bold text-gray-200">{pos.symbol.replace('USDT', '')}</td>
                    <td className="py-2 pr-3 text-gray-500 truncate max-w-[80px]">{pos.strategyName}</td>
                    <td className="py-2 pr-3 text-gray-400 num" title={pos.gridsFilled > 0 ? `최초 진입가 $${pos.entryPrice.toPrecision(5)} (그리드 ${pos.gridsFilled}차 반영 평균)` : undefined}>
                      ${(pos.avgEntryPrice > 0 ? pos.avgEntryPrice : pos.entryPrice).toPrecision(5)}
                      {pos.gridsFilled > 0 && <span className="text-gray-600 ml-0.5">({pos.gridsFilled}차)</span>}
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
                    <td className="py-2 pr-3 text-up num">${pos.takeProfitPrice.toPrecision(4)}</td>
                    <td className="py-2 pr-3 text-down num">${pos.stopLossPrice.toPrecision(4)}</td>
                    <td className="py-2 pr-3 text-gray-500">
                      {fmtDate(pos.expiresAt)}
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() => handleClose(pos.id)}
                        className="text-xs px-2 py-1 rounded border border-border text-gray-400 hover:text-down hover:border-down transition-colors"
                      >
                        청산
                      </button>
                    </td>
                  </tr>
                ))}
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
                      <div className="px-2 pb-2 pt-0 text-gray-500 border-t border-border/40 mt-0 space-y-0.5">
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

      {/* 사용 가이드 박스 */}
      <div className="card border-accent/20 bg-accent/5 text-xs text-gray-400 space-y-1.5">
        <p className="text-accent font-semibold text-sm mb-2">가상 지갑 사용법</p>
        <p>1. <strong className="text-gray-300">전략 설정</strong>에서 전략을 저장하고 <strong className="text-gray-300">활성화</strong>(●)하세요</p>
        <p>2. 위 <strong className="text-gray-300">▶ 스캐너 시작</strong>을 누르면 1분마다 전체 코인을 스캔합니다</p>
        <p>3. 설정 조건을 100% 충족한 코인이 발견되면 <strong className="text-gray-300">자동으로 가상 숏 포지션이 열립니다</strong></p>
        <p>4. TP/SL/타임아웃 조건이 충족되면 자동 청산 후 거래 로그에 기록됩니다</p>
        <p>5. 노트북을 켜두고 백엔드 서버가 실행 중이면 계속 자동으로 작동합니다</p>
      </div>
    </div>
  );
}

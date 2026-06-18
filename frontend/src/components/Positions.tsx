import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getPositions, getAccount, closePosition } from '../utils/api';
import { useStore } from '../store';
import { FuturesPosition, AccountInfo } from '../types';

function StatCard({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="card text-center">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold num ${valueClass ?? 'text-gray-100'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Positions() {
  const { positions, setPositions } = useStore();
  const [account, setAccount]   = useState<AccountInfo | null>(null);
  const [loading, setLoading]   = useState(true);
  const [closing, setClosing]   = useState<string | null>(null);
  const [noApiKey, setNoApiKey] = useState(false);

  const fetchAll = useCallback(async () => {
    try {
      const [pos, acc] = await Promise.all([getPositions(), getAccount()]);
      setPositions(pos);
      setAccount(acc);
      setNoApiKey(false);
    } catch (e: any) {
      if (e.response?.status === 500) setNoApiKey(true);
    } finally {
      setLoading(false);
    }
  }, [setPositions]);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const handleClose = async (pos: FuturesPosition) => {
    if (!confirm(`${pos.symbol} 포지션을 청산하겠습니까?`)) return;
    setClosing(pos.symbol);
    try {
      await closePosition(pos.symbol);
      await fetchAll();
    } catch (e: any) {
      alert(`청산 오류: ${e.response?.data?.error ?? e.message}`);
    } finally {
      setClosing(null);
    }
  };

  const totalPnl = positions.reduce((s, p) => s + p.unrealizedProfit, 0);

  // ── API 키 미설정 ────────────────────────────────────────────
  if (!loading && noApiKey) {
    return (
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="page-title">실제 포지션</h1>
          <p className="page-sub">Binance Futures 실계좌 포지션 관리</p>
        </div>
        <div className="card text-center py-12 border-warn/20 bg-warn/5">
          <div className="text-4xl mb-4">🔑</div>
          <div className="text-gray-200 font-semibold text-base mb-2">Binance API 키 미설정</div>
          <div className="text-gray-400 text-sm mb-5">
            실제 거래 기능을 사용하려면 API 키가 필요합니다
          </div>
          <div className="text-left max-w-sm mx-auto bg-surface rounded-xl p-4 text-xs text-gray-400 space-y-1.5">
            <p className="text-gray-300 font-semibold mb-2">설정 방법</p>
            <p>1. <code className="text-accent">backend/.env.example</code> → <code className="text-accent">backend/.env</code> 복사</p>
            <p>2. Binance → API Management에서 Futures 읽기/쓰기 권한 키 생성</p>
            <p>3. <code className="text-accent">BINANCE_API_KEY</code>, <code className="text-accent">BINANCE_API_SECRET</code> 입력</p>
            <p>4. 백엔드 재시작</p>
          </div>
          <p className="text-xs text-gray-500 mt-5">
            실제 거래 전에 <Link to="/paper" className="text-accent hover:underline">가상 지갑</Link>으로 먼저 테스트하세요
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* 헤더 */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="page-title">실제 포지션</h1>
          <p className="page-sub">Binance Futures 실계좌 — 5초 자동 갱신</p>
        </div>
        <button
          onClick={fetchAll}
          className="text-sm px-3 py-2 rounded-lg border border-border text-gray-400 hover:text-gray-200 transition-colors"
        >
          새로고침
        </button>
      </div>

      {/* 계좌 요약 */}
      {account && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="총 지갑 잔고"
            value={`$${account.totalWalletBalance.toFixed(2)}`}
          />
          <StatCard
            label="가용 잔고"
            value={`$${account.availableBalance.toFixed(2)}`}
          />
          <StatCard
            label="미실현 손익"
            value={`${account.totalUnrealizedProfit >= 0 ? '+' : ''}$${account.totalUnrealizedProfit.toFixed(2)}`}
            sub="전체 포지션 합계"
            valueClass={account.totalUnrealizedProfit >= 0 ? 'text-up' : 'text-down'}
          />
          <StatCard
            label="마진 잔고"
            value={`$${account.totalMarginBalance.toFixed(2)}`}
          />
        </div>
      )}

      {/* 포지션 목록 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="section-title">
            오픈 포지션
            <span className="text-gray-500 font-normal ml-2 text-xs">({positions.length}개)</span>
          </h2>
          {positions.length > 0 && (
            <span className={`text-sm font-semibold num ${totalPnl >= 0 ? 'text-up' : 'text-down'}`}>
              합계 {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </span>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : positions.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-3xl text-gray-700 mb-3">○</div>
            <p className="text-gray-500 text-sm">오픈 포지션 없음</p>
            <p className="text-gray-600 text-xs mt-1">
              스캐너에서 숏 후보를 찾거나{' '}
              <Link to="/paper" className="text-accent hover:underline">가상 지갑</Link>에서 자동 진입을 테스트하세요
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-border">
                  {['코인', '방향', '레버리지', '진입가', '현재가', '청산가', '미실현손익', ''].map(h => (
                    <th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map(pos => {
                  const pnlPct = pos.entryPrice > 0
                    ? ((pos.entryPrice - pos.markPrice) / pos.entryPrice) * 100 * pos.leverage
                    : 0;
                  const isWin = pos.unrealizedProfit >= 0;
                  return (
                    <tr key={pos.symbol} className="border-b border-border/40 hover:bg-white/3">
                      <td className="py-2.5 pr-3 font-bold text-gray-200">{pos.symbol.replace('USDT', '')}</td>
                      <td className="py-2.5 pr-3">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-down/15 text-down font-semibold">SHORT</span>
                      </td>
                      <td className="py-2.5 pr-3 text-gray-400 num">{pos.leverage}x</td>
                      <td className="py-2.5 pr-3 text-gray-300 num">${pos.entryPrice.toPrecision(5)}</td>
                      <td className="py-2.5 pr-3 text-gray-300 num">${pos.markPrice.toPrecision(5)}</td>
                      <td className="py-2.5 pr-3 text-warn num">${pos.liquidationPrice.toPrecision(5)}</td>
                      <td className="py-2.5 pr-3">
                        <div className={`font-bold num ${isWin ? 'text-up' : 'text-down'}`}>
                          {isWin ? '+' : ''}${pos.unrealizedProfit.toFixed(2)}
                        </div>
                        <div className={`text-xs num ${isWin ? 'text-up' : 'text-down'}`}>
                          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                        </div>
                      </td>
                      <td className="py-2.5">
                        <button
                          onClick={() => handleClose(pos)}
                          disabled={closing === pos.symbol}
                          className="text-xs px-2 py-1 rounded border border-border text-gray-400 hover:text-down hover:border-down transition-colors disabled:opacity-50"
                        >
                          {closing === pos.symbol ? '청산 중...' : '청산'}
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

      {/* 안내 박스 */}
      <div className="card border-warn/20 bg-warn/5 text-xs text-gray-400 space-y-1">
        <p className="text-warn font-semibold text-sm mb-2">실제 거래 주의사항</p>
        <p>• 이 페이지의 청산 버튼은 <strong className="text-gray-300">실제 Binance Futures 주문</strong>을 실행합니다</p>
        <p>• 레버리지 거래는 원금 이상의 손실이 발생할 수 있습니다</p>
        <p>• 먼저 <Link to="/paper" className="text-accent hover:underline">가상 지갑</Link>으로 충분히 테스트한 후 실거래 하세요</p>
      </div>
    </div>
  );
}

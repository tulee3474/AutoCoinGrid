import { useState } from 'react';
import { useStore } from '../store';
import { scanMarket, openShort } from '../utils/api';
import { MarketSnapshot } from '../types';
import clsx from 'clsx';

export default function Scanner() {
  const { draftConditions, draftTrade, scanResults, setScanResults, scanning, setScanning, btcDominance } = useStore();
  const [executing, setExecuting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const results = await scanMarket(draftConditions, btcDominance);
      setScanResults(results);
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message);
    } finally {
      setScanning(false);
    }
  };

  const handleShort = async (coin: MarketSnapshot) => {
    if (!confirm(`${coin.symbol} 숏 포지션을 여시겠습니까?\n레버리지: ${draftTrade.leverage}x, 진입: $${draftTrade.entryAmountUsdt}`)) return;
    setExecuting(coin.symbol);
    try {
      await openShort({
        symbol: coin.symbol,
        leverage: draftTrade.leverage,
        entryAmountUsdt: draftTrade.entryAmountUsdt,
        gridLevels: draftTrade.gridLevels,
        gridSpacing: draftTrade.gridSpacing,
        takeProfitPct: draftTrade.takeProfitPct,
        stopLossPct: draftTrade.stopLossPct
      });
      alert(`${coin.symbol} 숏 그리드 주문 완료`);
    } catch (e: any) {
      alert(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally {
      setExecuting(null);
    }
  };

  const signalColor = (score: number) => {
    if (score >= 80) return 'text-up';
    if (score >= 50) return 'text-warn';
    return 'text-gray-500';
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">시장 스캐너</h1>
        <p className="text-sm text-gray-500 mt-0.5">설정된 조건으로 숏 후보 코인 탐색</p>
      </div>

      {/* 조건 요약 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200">현재 진입 조건</h2>
          <a href="/strategy" className="text-xs text-accent hover:underline">조건 수정 →</a>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <CondChip label="RSI" value={`${draftConditions.rsi.min}–${draftConditions.rsi.max}`} />
          <CondChip label="24h 상승" value={`+${draftConditions.priceChange24h.min}%~+${draftConditions.priceChange24h.max}%`} />
          <CondChip label="볼륨 배수" value={`${draftConditions.volumeMultiplier.min}x 이상`} />
          <CondChip label="BTC 도미넌스" value={`≤ ${draftConditions.btcDominanceMax}%`} />
        </div>
      </div>

      <button
        onClick={handleScan}
        disabled={scanning}
        className="btn-primary flex items-center gap-2 disabled:opacity-50"
      >
        {scanning ? (
          <>
            <span className="animate-spin inline-block">⟳</span>
            스캔 중...
          </>
        ) : '스캔 시작'}
      </button>

      {error && (
        <div className="p-4 bg-down/10 border border-down/30 rounded-lg text-down text-sm">{error}</div>
      )}

      {/* 결과 테이블 */}
      {scanResults.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-200">
              스캔 결과 <span className="text-accent ml-2">{scanResults.length}개</span>
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-border">
                  <th className="text-left pb-2">코인</th>
                  <th className="text-right pb-2">현재가</th>
                  <th className="text-right pb-2">24h 변화</th>
                  <th className="text-right pb-2">RSI</th>
                  <th className="text-right pb-2">볼륨배수</th>
                  <th className="text-right pb-2">MA200 위</th>
                  <th className="text-right pb-2">시그널</th>
                  <th className="text-right pb-2">액션</th>
                </tr>
              </thead>
              <tbody>
                {scanResults.map(coin => (
                  <tr key={coin.symbol} className="border-b border-border/40 hover:bg-border/20">
                    <td className="py-2.5 font-semibold text-gray-200">
                      {coin.symbol.replace('USDT', '')}
                    </td>
                    <td className="py-2.5 text-right text-gray-300">
                      ${coin.price < 1 ? coin.price.toFixed(5) : coin.price.toFixed(3)}
                    </td>
                    <td className="py-2.5 text-right">
                      <span className="badge-up">+{coin.change24h.toFixed(1)}%</span>
                    </td>
                    <td className={clsx('py-2.5 text-right font-mono',
                      coin.rsi14 >= 70 ? 'text-down' : coin.rsi14 >= 50 ? 'text-warn' : 'text-up'
                    )}>
                      {coin.rsi14.toFixed(1)}
                    </td>
                    <td className="py-2.5 text-right text-gray-300">
                      {coin.volumeRatio.toFixed(1)}x
                    </td>
                    <td className="py-2.5 text-right">
                      {coin.aboveMa200
                        ? <span className="text-up">✓</span>
                        : <span className="text-gray-600">✗</span>
                      }
                    </td>
                    <td className={clsx('py-2.5 text-right font-bold', signalColor(coin.signalScore))}>
                      {coin.signalScore}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        onClick={() => handleShort(coin)}
                        disabled={executing === coin.symbol}
                        className="btn-danger text-xs py-1 px-2 disabled:opacity-50"
                      >
                        {executing === coin.symbol ? '...' : '숏 진입'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function CondChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-lg p-2.5">
      <div className="text-gray-500 mb-0.5">{label}</div>
      <div className="text-gray-200 font-semibold">{value}</div>
    </div>
  );
}

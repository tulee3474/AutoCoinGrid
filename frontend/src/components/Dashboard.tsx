import { useEffect, useState } from 'react';
import { getTopTickers, getAccount } from '../utils/api';
import { useStore } from '../store';
import { AccountInfo } from '../types';

interface Ticker {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      <div className="text-2xl font-semibold text-gray-100">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const { btcDominance, positions, setTopTickers } = useStore();
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTickers = () =>
      getTopTickers().then(data => {
        setTickers(data);
        // 급등 코인 목록을 전역 스토어에 저장 (Backtest 등 다른 페이지에서 사용)
        setTopTickers(data.map((t: Ticker) => ({ symbol: t.symbol, change24h: t.change24h, volume24h: t.volume24h })));
      }).catch(() => {});

    Promise.all([fetchTickers(), getAccount().then(setAccount).catch(() => {})])
      .finally(() => setLoading(false));

    const id = setInterval(fetchTickers, 10_000);
    return () => clearInterval(id);
  }, [setTopTickers]);

  const topGainers = tickers.filter(t => t.change24h > 0).slice(0, 10);
  const topLosers = [...tickers].sort((a, b) => a.change24h - b.change24h).slice(0, 5);
  const shortCandidates = tickers.filter(t => t.change24h >= 30).slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">대시보드</h1>
        <p className="text-sm text-gray-500 mt-0.5">실시간 시장 현황 및 포지션 요약</p>
      </div>

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="BTC 도미넌스"
          value={`${btcDominance.toFixed(1)}%`}
          sub={btcDominance > 55 ? '↑ 알트 약세 주의' : '알트 매매 가능'}
        />
        <StatCard
          label="숏 후보 코인"
          value={`${shortCandidates.length}개`}
          sub="24h +30% 이상"
        />
        <StatCard
          label="오픈 포지션"
          value={`${positions.length}개`}
          sub="활성 숏 포지션"
        />
        <StatCard
          label="잔고"
          value={account ? `$${account.totalWalletBalance.toFixed(2)}` : '—'}
          sub={account ? `미실현: $${account.totalUnrealizedProfit.toFixed(2)}` : 'API 키 필요'}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 24h 급등 코인 (숏 후보) */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-200">24h 급등 코인 — 숏 후보</h2>
            {loading && <span className="text-xs text-gray-500 animate-pulse">로딩 중...</span>}
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-border">
                <th className="text-left pb-2">심볼</th>
                <th className="text-right pb-2">현재가</th>
                <th className="text-right pb-2">24h 변화</th>
                <th className="text-right pb-2">볼륨 (M)</th>
              </tr>
            </thead>
            <tbody>
              {topGainers.map(t => (
                <tr key={t.symbol} className="border-b border-border/40 hover:bg-border/20">
                  <td className="py-2 font-medium text-gray-200">
                    {t.symbol.replace('USDT', '')}
                  </td>
                  <td className="py-2 text-right text-gray-300">
                    ${t.price < 1 ? t.price.toFixed(6) : t.price.toFixed(2)}
                  </td>
                  <td className="py-2 text-right">
                    <span className={t.change24h >= 0 ? 'badge-up' : 'badge-down'}>
                      {t.change24h >= 0 ? '+' : ''}{t.change24h.toFixed(2)}%
                    </span>
                  </td>
                  <td className="py-2 text-right text-gray-400">
                    ${(t.volume24h / 1_000_000).toFixed(1)}M
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 숏 시그널 현황 */}
        <div className="card">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">진입 조건 요약</h2>
          <div className="space-y-3">
            <ConditionRow
              label="BTC 도미넌스"
              value={`${btcDominance.toFixed(1)}%`}
              pass={btcDominance <= 55}
              detail="≤ 55% 조건"
            />
            <ConditionRow
              label="급등 코인 수"
              value={`${shortCandidates.length}개`}
              pass={shortCandidates.length >= 3}
              detail="24h +30% 이상 3개 이상"
            />
            <ConditionRow
              label="API 연결"
              value={account ? '연결됨' : '미연결'}
              pass={!!account}
              detail="트레이딩 기능 활성화"
            />
          </div>

          <div className="mt-6">
            <h3 className="text-xs text-gray-500 mb-3">24h 급락 코인 (반등 주의)</h3>
            <div className="space-y-1.5">
              {topLosers.map(t => (
                <div key={t.symbol} className="flex items-center justify-between text-xs">
                  <span className="text-gray-400">{t.symbol.replace('USDT', '')}</span>
                  <span className="badge-down">{t.change24h.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConditionRow({ label, value, pass, detail }: {
  label: string; value: string; pass: boolean; detail: string;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-surface">
      <div>
        <div className="text-sm text-gray-200">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{detail}</div>
      </div>
      <div className="text-right">
        <div className={`text-sm font-semibold ${pass ? 'text-up' : 'text-down'}`}>{value}</div>
        <div className={`text-xs ${pass ? 'text-up' : 'text-down'}`}>{pass ? '✓ 충족' : '✗ 미충족'}</div>
      </div>
    </div>
  );
}

import { Outlet, NavLink } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from '../store';
import { getBtcDominance } from '../utils/api';

const NAV = [
  { to: '/dashboard', label: '대시보드',   icon: '◈' },
  { to: '/scanner',   label: '스캐너',     icon: '⟳' },
  { to: '/strategy',  label: '전략 설정',  icon: '◧' },
  { to: '/backtest',  label: '백테스트',   icon: '◎' },
  { to: '/paper',     label: '가상 지갑',  icon: '◷' },
  { to: '/positions', label: '실제 포지션', icon: '◉' },
];

export default function Layout() {
  const { btcDominance, setBtcDominance } = useStore();

  useEffect(() => {
    const fetch = () => getBtcDominance().then(setBtcDominance).catch(() => {});
    fetch();
    const id = setInterval(fetch, 60_000);
    return () => clearInterval(id);
  }, [setBtcDominance]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 bg-card border-r border-border flex flex-col flex-shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-border">
          <div className="text-base font-bold text-accent tracking-wide">AutoCoin</div>
          <div className="text-xs text-gray-500 mt-0.5">숏 그리드 자동매매</div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-accent/15 text-accent font-semibold'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`
              }
            >
              <span className="text-base w-5 text-center opacity-70">{icon}</span>
              {label}
            </NavLink>
          ))}

          {/* 구분선 */}
          <div className="border-t border-border my-2" />

          <NavLink
            to="/guide"
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-accent/15 text-accent font-semibold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
              }`
            }
          >
            <span className="text-base w-5 text-center opacity-70">?</span>
            사용 가이드
          </NavLink>
        </nav>

        {/* BTC Dominance */}
        <div className="p-4 border-t border-border">
          <div className="text-xs text-gray-500 mb-2">BTC 도미넌스</div>
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-warn rounded-full transition-all duration-500"
                style={{ width: `${Math.min(btcDominance, 100)}%` }}
              />
            </div>
            <span className="text-xs font-bold text-warn num w-12 text-right">
              {btcDominance.toFixed(1)}%
            </span>
          </div>
          <div className="text-xs text-gray-600 mt-1">
            {btcDominance > 55 ? '알트 약세 구간' : '알트 매매 가능'}
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto p-6 bg-surface">
        <Outlet />
      </main>
    </div>
  );
}

import { useState, useEffect, FormEvent } from 'react';
import {
  adminLogin, getAdminStats, getAdminUsers, deleteAdminUser,
  AdminUser
} from '../utils/api';

interface Stats {
  userCount: number;
  activeStrategies: number;
  livePositionCount: number;
  paperPositionCount: number;
}

export default function Admin() {
  const [authed, setAuthed]   = useState(() => !!localStorage.getItem('adminToken'));
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const [stats, setStats]     = useState<Stats | null>(null);
  const [users, setUsers]     = useState<AdminUser[]>([]);
  const [search, setSearch]   = useState('');

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { token } = await adminLogin(password);
      localStorage.setItem('adminToken', token);
      setAuthed(true);
    } catch (err: any) {
      setError(err.response?.data?.error ?? '비밀번호가 틀렸습니다');
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem('adminToken');
    setAuthed(false);
    setStats(null);
    setUsers([]);
  }

  useEffect(() => {
    if (!authed) return;
    Promise.all([getAdminStats(), getAdminUsers()])
      .then(([s, u]) => { setStats(s); setUsers(u); })
      .catch(() => { handleLogout(); });
  }, [authed]);

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
    try {
      await deleteAdminUser(userId);
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (err: any) {
      alert(err.response?.data?.error ?? '삭제 실패');
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-2xl font-bold text-accent">AutoCoin</div>
            <div className="text-sm text-gray-500 mt-1">관리자 페이지</div>
          </div>

          <div className="bg-card border border-border rounded-xl p-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">관리자 비밀번호</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoFocus
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent"
                  placeholder="비밀번호 입력"
                />
              </div>

              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-accent text-black font-semibold py-2 rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50"
              >
                {loading ? '확인 중...' : '로그인'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const filtered = users.filter(u =>
    u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-surface p-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-100">관리자 대시보드</h1>
          <p className="text-sm text-gray-500 mt-0.5">AutoCoin</p>
        </div>
        <button
          onClick={handleLogout}
          className="text-sm text-gray-400 hover:text-gray-200 border border-border rounded-lg px-3 py-1.5"
        >
          로그아웃
        </button>
      </div>

      {/* 통계 카드 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[
            { label: '총 사용자',        value: stats.userCount,          color: 'text-accent' },
            { label: '활성 전략',         value: stats.activeStrategies,   color: 'text-green-400' },
            { label: '실거래 포지션',     value: stats.livePositionCount,  color: 'text-yellow-400' },
            { label: '가상 포지션',       value: stats.paperPositionCount, color: 'text-blue-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={`text-2xl font-bold ${color}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 사용자 목록 */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-300">사용자 목록</h2>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="이메일 검색"
            className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-accent w-48"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 border-b border-border">
                <th className="text-left py-2 pr-4">이메일</th>
                <th className="text-left py-2 pr-4">가입일</th>
                <th className="text-center py-2 pr-4">API키</th>
                <th className="text-center py-2 pr-4">전략</th>
                <th className="text-center py-2 pr-4">실거래</th>
                <th className="text-right py-2 pr-4">가상잔고</th>
                <th className="text-right py-2">액션</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-gray-500">
                    사용자 없음
                  </td>
                </tr>
              )}
              {filtered.map(u => (
                <tr key={u.id} className="border-b border-border/50 hover:bg-white/3">
                  <td className="py-3 pr-4 text-gray-200">{u.email}</td>
                  <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">
                    {new Date(u.createdAt).toLocaleDateString('ko')}
                  </td>
                  <td className="py-3 pr-4 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      u.hasApiKeys
                        ? 'bg-green-500/15 text-green-400'
                        : 'bg-gray-500/15 text-gray-500'
                    }`}>
                      {u.hasApiKeys ? '등록' : '없음'}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-center text-gray-300">{u.strategies}</td>
                  <td className="py-3 pr-4 text-center text-gray-300">{u.liveTrades}</td>
                  <td className="py-3 pr-4 text-right text-gray-300">
                    {u.paperBalance != null ? `$${u.paperBalance.toFixed(0)}` : '-'}
                  </td>
                  <td className="py-3 text-right">
                    <button
                      onClick={() => handleDelete(u.id, u.email)}
                      className="text-xs text-red-400 hover:text-red-300 border border-red-400/30 rounded px-2 py-0.5"
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

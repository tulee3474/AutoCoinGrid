import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login, register, isLoading } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode]       = useState<'login' | 'register'>('login');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError]     = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (mode === 'register' && password !== confirm) {
      setError('비밀번호가 일치하지 않습니다');
      return;
    }

    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password);
      }
      navigate('/dashboard', { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.error ?? '오류가 발생했습니다');
    }
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* 로고 */}
        <div className="text-center mb-8">
          <div className="text-2xl font-bold text-accent tracking-wide">AutoCoin</div>
          <div className="text-sm text-gray-500 mt-1">숏 그리드 자동매매</div>
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          {/* 탭 */}
          <div className="flex mb-6 bg-surface rounded-lg p-1">
            {(['login', 'register'] as const).map(m => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(''); }}
                className={`flex-1 py-1.5 text-sm rounded-md transition-colors ${
                  mode === m ? 'bg-accent text-black font-semibold' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {m === 'login' ? '로그인' : '회원가입'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">이메일</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent"
                placeholder="example@email.com"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">비밀번호</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent"
                placeholder="8자 이상"
              />
            </div>

            {mode === 'register' && (
              <div>
                <label className="block text-xs text-gray-400 mb-1">비밀번호 확인</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent"
                  placeholder="비밀번호 재입력"
                />
              </div>
            )}

            {error && (
              <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-accent text-black font-semibold py-2 rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50 transition-colors"
            >
              {isLoading ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

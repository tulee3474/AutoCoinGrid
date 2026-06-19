import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { saveApiKeys, deleteApiKeys } from '../utils/api';

export default function Profile() {
  const { user, logout, refreshUser } = useAuth();

  const [apiKey, setApiKey]       = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [saving, setSaving]       = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || !apiSecret.trim()) {
      setError('API Key와 Secret을 모두 입력하세요');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await saveApiKeys(apiKey.trim(), apiSecret.trim());
      await refreshUser();
      setApiKey('');
      setApiSecret('');
      setShowForm(false);
      setSuccess('API 키가 등록되었습니다');
    } catch (e: any) {
      setError(e.response?.data?.error ?? '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('등록된 Binance API 키를 삭제합니까? 실제 거래와 가상 지갑 스캐너가 중지됩니다.')) return;
    setDeleting(true);
    setError('');
    setSuccess('');
    try {
      await deleteApiKeys();
      await refreshUser();
      setSuccess('API 키가 삭제되었습니다');
    } catch (e: any) {
      setError(e.response?.data?.error ?? '삭제 실패');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="page-title">내 정보</h1>
        <p className="page-sub">계정 정보 및 Binance API 키 관리</p>
      </div>

      {/* 계정 정보 */}
      <div className="card space-y-4">
        <h2 className="section-title">계정</h2>
        <div className="flex items-center justify-between py-2 border-b border-border">
          <span className="text-sm text-gray-400">이메일</span>
          <span className="text-sm text-gray-200">{user?.email}</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-gray-400">Binance API 키</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
            user?.hasApiKeys
              ? 'bg-up/15 text-up'
              : 'bg-border text-gray-400'
          }`}>
            {user?.hasApiKeys ? '● 등록됨' : '미등록'}
          </span>
        </div>
        <button
          onClick={logout}
          className="w-full text-sm py-2 rounded-lg border border-border text-gray-400 hover:text-down hover:border-down/40 transition-colors"
        >
          로그아웃
        </button>
      </div>

      {/* API 키 관리 */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="section-title">Binance API 키</h2>
          {user?.hasApiKeys && !showForm && (
            <button
              onClick={() => { setShowForm(true); setError(''); setSuccess(''); }}
              className="text-xs text-accent hover:underline"
            >
              재등록
            </button>
          )}
        </div>

        {success && (
          <div className="text-xs text-up bg-up/10 border border-up/20 rounded-lg px-3 py-2">
            {success}
          </div>
        )}
        {error && (
          <div className="text-xs text-down bg-down/10 border border-down/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {user?.hasApiKeys && !showForm ? (
          <div className="space-y-3">
            <div className="p-3 bg-surface rounded-lg text-xs text-gray-400 space-y-1">
              <p>API Key: <span className="text-gray-300 font-mono">••••••••••••••••</span></p>
              <p>Secret:  <span className="text-gray-300 font-mono">••••••••••••••••</span></p>
              <p className="text-gray-600 mt-2">보안을 위해 저장된 키는 표시되지 않습니다</p>
            </div>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full text-sm py-2 rounded-lg border border-down/30 text-down hover:bg-down/10 transition-colors disabled:opacity-50"
            >
              {deleting ? '삭제 중...' : '키 삭제'}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="p-3 bg-down/5 border border-down/20 rounded-lg text-xs text-gray-400 space-y-1">
              <p className="text-down font-semibold">⚠ 보안 주의사항</p>
              <p>· Futures(선물) 거래 권한만 부여하세요 — 출금 권한은 절대 금지</p>
              <p>· IP 화이트리스트에 서버 IP(13.209.72.56)를 추가하면 더 안전합니다</p>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">API Key</label>
              <input
                type="text"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="Binance API Key"
                className="input w-full font-mono text-sm"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">API Secret</label>
              <input
                type="password"
                value={apiSecret}
                onChange={e => setApiSecret(e.target.value)}
                placeholder="Binance API Secret"
                className="input w-full font-mono text-sm"
                autoComplete="new-password"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 text-sm py-2 rounded-lg bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                {saving ? '저장 중...' : '저장'}
              </button>
              {showForm && user?.hasApiKeys && (
                <button
                  type="button"
                  onClick={() => { setShowForm(false); setError(''); }}
                  className="text-sm px-4 py-2 rounded-lg border border-border text-gray-400 hover:text-gray-200 transition-colors"
                >
                  취소
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {/* API 키 발급 안내 */}
      {!user?.hasApiKeys && (
        <div className="card text-xs text-gray-400 space-y-2">
          <p className="font-semibold text-gray-300 mb-2">Binance API 키 발급 방법</p>
          <p>1. Binance 로그인 → 우측 상단 프로필 → <strong className="text-gray-200">API Management</strong></p>
          <p>2. <strong className="text-gray-200">API 키 생성</strong> → 이름 입력 → 시스템 생성 키 선택</p>
          <p>3. 권한: <strong className="text-gray-200">선물 거래 활성화</strong> 체크 (현물·출금은 체크 해제)</p>
          <p>4. 생성된 API Key, Secret을 위 폼에 입력</p>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, FormEvent } from 'react';
import {
  adminLogin, getAdminStats, getAdminUsers, deleteAdminUser,
  getAdminScanners,
  adminStartPaperScanner, adminStopPaperScanner,
  adminStartLiveScanner, adminStopLiveScanner,
  getBtcDomDataInfo, fetchBtcDomFromCoinGecko, uploadBtcDomCSV, deleteBtcDomData,
  getPresets, adminCreatePreset, adminUpdatePreset, adminDeletePreset,
  AdminUser, AdminPreset
} from '../utils/api';
import { StrategyConditions, TradeConfig, DEFAULT_CONDITIONS, DEFAULT_TRADE } from '../types';

interface Stats {
  userCount: number;
  activeStrategies: number;
  livePositionCount: number;
  paperPositionCount: number;
}

// ── 프리셋 폼 컴포넌트 ─────────────────────────────────────────

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      {children}
    </div>
  );
}

function Num({ label, value, onChange, unit = '' }: {
  label: string; value: number; onChange: (v: number) => void; unit?: string;
}) {
  return (
    <F label={label}>
      <div className="flex items-center gap-1">
        <input type="number" value={value} onChange={e => onChange(+e.target.value)}
          className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
        {unit && <span className="text-xs text-gray-500 flex-shrink-0">{unit}</span>}
      </div>
    </F>
  );
}

function Range({ label, min, max, onMin, onMax, unit = '' }: {
  label: string; min: number; max: number;
  onMin: (v: number) => void; onMax: (v: number) => void; unit?: string;
}) {
  return (
    <F label={label}>
      <div className="flex items-center gap-1">
        <input type="number" value={min} onChange={e => onMin(+e.target.value)}
          className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
        <span className="text-gray-500 text-xs flex-shrink-0">~</span>
        <input type="number" value={max} onChange={e => onMax(+e.target.value)}
          className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
        {unit && <span className="text-xs text-gray-500 flex-shrink-0">{unit}</span>}
      </div>
    </F>
  );
}

function PresetForm({
  initial, onSave, onCancel, loading
}: {
  initial: { name: string; conditions: StrategyConditions; trade: TradeConfig };
  onSave: (name: string, c: StrategyConditions, t: TradeConfig) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [name, setName] = useState(initial.name);
  const [c, setC] = useState<StrategyConditions>(initial.conditions);
  const [t, setT] = useState<TradeConfig>(initial.trade);

  const sc = (patch: Partial<StrategyConditions>) => setC(prev => ({ ...prev, ...patch }));
  const st = (patch: Partial<TradeConfig>) => setT(prev => ({ ...prev, ...patch }));

  return (
    <div className="mt-3 p-4 bg-surface rounded-xl border border-border space-y-4">
      <F label="전략 이름">
        <input value={name} onChange={e => setName(e.target.value)}
          className="w-full bg-card border border-border rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-accent" />
      </F>

      <div>
        <div className="text-xs font-semibold text-gray-400 mb-2">진입 조건</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Range label={`RSI (${c.rsi.period}일) 범위`} min={c.rsi.min} max={c.rsi.max}
            onMin={v => sc({ rsi: { ...c.rsi, min: v } })}
            onMax={v => sc({ rsi: { ...c.rsi, max: v } })} />
          <Range label="24h 상승률" unit="%" min={c.priceChange24h.min} max={c.priceChange24h.max}
            onMin={v => sc({ priceChange24h: { ...c.priceChange24h, min: v } })}
            onMax={v => sc({ priceChange24h: { ...c.priceChange24h, max: v } })} />
          <Range label="볼륨 배수" unit="x" min={c.volumeMultiplier.min} max={c.volumeMultiplier.max}
            onMin={v => sc({ volumeMultiplier: { ...c.volumeMultiplier, min: v } })}
            onMax={v => sc({ volumeMultiplier: { ...c.volumeMultiplier, max: v } })} />
          <Num label="BTC 도미넌스 최대" unit="%" value={c.btcDominanceMax}
            onChange={v => sc({ btcDominanceMax: v })} />
          <F label="RSI 기간">
            <select value={c.rsi.period}
              onChange={e => sc({ rsi: { ...c.rsi, period: +e.target.value } })}
              className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent">
              {[5, 7, 14].map(p => <option key={p} value={p}>{p}일</option>)}
            </select>
          </F>
          <F label="RSI 기준 봉">
            <select value={c.rsi.timeframe}
              onChange={e => sc({ rsi: { ...c.rsi, timeframe: e.target.value } })}
              className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent">
              <option value="1h">1시간봉</option>
              <option value="4h">4시간봉</option>
              <option value="1d">일봉</option>
            </select>
          </F>
          <F label="MA200 위 코인만">
            <div className="flex items-center gap-2 mt-1">
              <input type="checkbox" id="ma200-form" checked={c.priceAboveMa200}
                onChange={e => sc({ priceAboveMa200: e.target.checked })}
                className="w-4 h-4 accent-accent" />
              <label htmlFor="ma200-form" className="text-xs text-gray-300 cursor-pointer">사용</label>
            </div>
          </F>
          <F label="볼린저 상단 돌파만">
            <div className="flex items-center gap-2 mt-1">
              <input type="checkbox" id="bb-form" checked={c.priceAboveBB}
                onChange={e => sc({ priceAboveBB: e.target.checked })}
                className="w-4 h-4 accent-accent" />
              <label htmlFor="bb-form" className="text-xs text-gray-300 cursor-pointer">사용</label>
            </div>
          </F>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-gray-400 mb-2">거래 설정</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Num label="레버리지" unit="x" value={t.leverage} onChange={v => st({ leverage: v })} />
          <Num label="진입 금액" unit="USDT" value={t.entryAmountUsdt} onChange={v => st({ entryAmountUsdt: v })} />
          <Num label="그리드 레벨" value={t.gridLevels} onChange={v => st({ gridLevels: v })} />
          <Num label="물타기 간격 (PDF)" value={t.gridSpacing} onChange={v => st({ gridSpacing: v })} />
          <Num label="익절" unit="% 하락시" value={t.takeProfitPct} onChange={v => st({ takeProfitPct: v })} />
          <Num label="최대 보유" unit="시간" value={t.maxDurationHours ?? 72} onChange={v => st({ maxDurationHours: v })} />
        </div>
        <div className="text-xs text-gray-500 p-2 bg-card rounded-lg">
          자동 손절: 평균 진입가 기준 {(t.gridSpacing / t.leverage).toFixed(1)}% 간격 × {t.gridLevels}단계 + 1 (레버리지 반영)
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={() => onSave(name, c, t)} disabled={loading || !name.trim()}
          className="text-xs bg-accent text-black font-semibold px-4 py-1.5 rounded-lg hover:bg-accent/90 disabled:opacity-50">
          {loading ? '저장 중...' : '저장'}
        </button>
        <button onClick={onCancel}
          className="text-xs text-gray-400 border border-border px-4 py-1.5 rounded-lg hover:text-gray-200">
          취소
        </button>
      </div>
    </div>
  );
}

function presetSummary(c: StrategyConditions) {
  return `RSI ${c.rsi.min}~${c.rsi.max} · 24h +${c.priceChange24h.min}% · 도미넌스 <${c.btcDominanceMax}%`;
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────

export default function Admin() {
  const [authed, setAuthed]     = useState(() => !!localStorage.getItem('adminToken'));
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState('');
  const [paperIds, setPaperIds] = useState(new Set<string>());
  const [liveIds, setLiveIds]   = useState(new Set<string>());
  const [scannerLoading, setScannerLoading] = useState<string | null>(null);

  const [domInfo, setDomInfo]       = useState<{ hasData: boolean; count?: number; dateRange?: string } | null>(null);
  const [domLoading, setDomLoading] = useState(false);
  const [domMsg, setDomMsg]         = useState('');
  const [csvText, setCsvText]       = useState('');

  const [defaultPreset, setDefaultPreset]       = useState<AdminPreset | null>(null);
  const [recommended, setRecommended]           = useState<AdminPreset[]>([]);
  const [editingPreset, setEditingPreset]       = useState<AdminPreset | null | 'new-recommended'>(null);
  const [showDefaultForm, setShowDefaultForm]   = useState(false);
  const [presetLoading, setPresetLoading]       = useState(false);
  const [presetMsg, setPresetMsg]               = useState('');

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

  async function loadPresets() {
    const data = await getPresets();
    setDefaultPreset(data.default);
    setRecommended(data.recommended);
  }

  useEffect(() => {
    if (!authed) return;
    Promise.all([getAdminStats(), getAdminUsers(), getBtcDomDataInfo(), getAdminScanners()])
      .then(([s, u, d, sc]) => {
        setStats(s); setUsers(u); setDomInfo(d);
        setPaperIds(new Set(sc.paperUserIds));
        setLiveIds(new Set(sc.liveUserIds));
      })
      .catch(() => handleLogout());
    loadPresets();
  }, [authed]);

  // ── 도미넌스 핸들러 ───────────────────────────────────────────

  async function handleDomFetch() {
    setDomLoading(true); setDomMsg('');
    try {
      const r = await fetchBtcDomFromCoinGecko(365);
      setDomInfo(r.info);
      setDomMsg(`완료: ${r.saved}개 저장 (${r.dateRange})`);
    } catch (e: any) {
      setDomMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally { setDomLoading(false); }
  }

  async function handleDomUpload() {
    if (!csvText.trim()) return;
    setDomLoading(true); setDomMsg('');
    try {
      const r = await uploadBtcDomCSV(csvText);
      setDomInfo(r.info);
      setDomMsg(`완료: ${r.saved}개 저장, 오류 ${r.errors}개`);
      setCsvText('');
    } catch (e: any) {
      setDomMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally { setDomLoading(false); }
  }

  async function handleDomDelete() {
    if (!confirm('도미넌스 데이터를 모두 삭제하시겠습니까?')) return;
    setDomLoading(true); setDomMsg('');
    try {
      await deleteBtcDomData();
      setDomInfo({ hasData: false });
      setDomMsg('삭제 완료');
    } catch (e: any) {
      setDomMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally { setDomLoading(false); }
  }

  // ── 프리셋 핸들러 ─────────────────────────────────────────────

  async function handleSaveDefault(name: string, conditions: StrategyConditions, trade: TradeConfig) {
    setPresetLoading(true); setPresetMsg('');
    try {
      await adminCreatePreset({ type: 'default', name, conditions, trade, sortOrder: 0 });
      await loadPresets();
      setShowDefaultForm(false);
      setPresetMsg('기본 전략 저장 완료');
    } catch (e: any) {
      setPresetMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally { setPresetLoading(false); }
  }

  async function handleSaveRecommended(name: string, conditions: StrategyConditions, trade: TradeConfig) {
    setPresetLoading(true); setPresetMsg('');
    try {
      if (editingPreset && editingPreset !== 'new-recommended') {
        await adminUpdatePreset(editingPreset.id, { name, conditions, trade });
      } else {
        await adminCreatePreset({ type: 'recommended', name, conditions, trade, sortOrder: recommended.length });
      }
      await loadPresets();
      setEditingPreset(null);
      setPresetMsg('추천 전략 저장 완료');
    } catch (e: any) {
      setPresetMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    } finally { setPresetLoading(false); }
  }

  async function handleDeletePreset(id: string) {
    if (!confirm('전략 프리셋을 삭제하시겠습니까?')) return;
    try {
      await adminDeletePreset(id);
      await loadPresets();
    } catch (e: any) {
      setPresetMsg(`오류: ${e.response?.data?.error ?? e.message}`);
    }
  }

  async function handlePaperToggle(userId: string) {
    setScannerLoading(`paper-${userId}`);
    try {
      if (paperIds.has(userId)) {
        await adminStopPaperScanner(userId);
        setPaperIds(prev => { const s = new Set(prev); s.delete(userId); return s; });
      } else {
        await adminStartPaperScanner(userId);
        setPaperIds(prev => new Set([...prev, userId]));
      }
    } catch (e: any) {
      alert(e.response?.data?.error ?? '스캐너 오류');
    } finally {
      setScannerLoading(null);
    }
  }

  async function handleLiveToggle(userId: string) {
    setScannerLoading(`live-${userId}`);
    try {
      if (liveIds.has(userId)) {
        await adminStopLiveScanner(userId);
        setLiveIds(prev => { const s = new Set(prev); s.delete(userId); return s; });
      } else {
        await adminStartLiveScanner(userId);
        setLiveIds(prev => new Set([...prev, userId]));
      }
    } catch (e: any) {
      alert(e.response?.data?.error ?? '스캐너 오류');
    } finally {
      setScannerLoading(null);
    }
  }

  async function handleDelete(userId: string, email: string) {
    if (!confirm(`${email} 계정을 삭제하시겠습니까?`)) return;
    try {
      await deleteAdminUser(userId);
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (err: any) {
      alert(err.response?.data?.error ?? '삭제 실패');
    }
  }

  // ── 로그인 화면 ───────────────────────────────────────────────

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
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  required autoFocus
                  className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-accent"
                  placeholder="비밀번호 입력" />
              </div>
              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>
              )}
              <button type="submit" disabled={loading}
                className="w-full bg-accent text-black font-semibold py-2 rounded-lg text-sm hover:bg-accent/90 disabled:opacity-50">
                {loading ? '확인 중...' : '로그인'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const filtered = users.filter(u => u.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="min-h-screen bg-surface p-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-100">관리자 대시보드</h1>
          <p className="text-sm text-gray-500 mt-0.5">AutoCoin</p>
        </div>
        <button onClick={handleLogout}
          className="text-sm text-gray-400 hover:text-gray-200 border border-border rounded-lg px-3 py-1.5">
          로그아웃
        </button>
      </div>

      {/* 통계 카드 */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[
            { label: '총 사용자',    value: stats.userCount,          color: 'text-accent' },
            { label: '활성 전략',    value: stats.activeStrategies,   color: 'text-green-400' },
            { label: '실거래 포지션', value: stats.livePositionCount,  color: 'text-yellow-400' },
            { label: '가상 포지션',  value: stats.paperPositionCount, color: 'text-blue-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-card border border-border rounded-xl p-4">
              <div className="text-xs text-gray-500 mb-1">{label}</div>
              <div className={`text-2xl font-bold ${color}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* 전략 프리셋 관리 */}
      <div className="bg-card border border-border rounded-xl p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">전략 프리셋 관리</h2>

        {presetMsg && (
          <div className={`mb-3 text-xs px-3 py-2 rounded-lg ${
            presetMsg.startsWith('오류')
              ? 'bg-red-400/10 text-red-400 border border-red-400/20'
              : 'bg-green-400/10 text-green-400 border border-green-400/20'
          }`}>{presetMsg}</div>
        )}

        {/* 기본 전략 */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-400">기본 전략 (사용자 페이지 첫 방문시 자동 적용)</div>
            <button onClick={() => { setShowDefaultForm(v => !v); setPresetMsg(''); }}
              className="text-xs text-accent hover:underline">
              {showDefaultForm ? '취소' : defaultPreset ? '수정' : '설정'}
            </button>
          </div>

          {defaultPreset && !showDefaultForm && (
            <div className="p-3 bg-surface rounded-lg">
              <div className="text-sm text-gray-200 font-medium">{defaultPreset.name}</div>
              <div className="text-xs text-gray-500 mt-0.5">{presetSummary(defaultPreset.conditions as StrategyConditions)}</div>
            </div>
          )}
          {!defaultPreset && !showDefaultForm && (
            <div className="text-xs text-gray-500 p-3 bg-surface rounded-lg">기본 전략 미설정 — 하드코딩 기본값 사용 중</div>
          )}

          {showDefaultForm && (
            <PresetForm
              initial={{
                name: defaultPreset?.name ?? '기본 전략',
                conditions: (defaultPreset?.conditions as StrategyConditions) ?? DEFAULT_CONDITIONS,
                trade: (defaultPreset?.trade as TradeConfig) ?? DEFAULT_TRADE,
              }}
              onSave={handleSaveDefault}
              onCancel={() => setShowDefaultForm(false)}
              loading={presetLoading}
            />
          )}
        </div>

        {/* 추천 전략 목록 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-400">추천 전략 ({recommended.length}개)</div>
            <button
              onClick={() => { setEditingPreset('new-recommended'); setPresetMsg(''); }}
              className="text-xs bg-accent/20 text-accent border border-accent/30 px-2 py-1 rounded-lg hover:bg-accent/30">
              + 추가
            </button>
          </div>

          <div className="space-y-2">
            {recommended.map((p, i) => (
              <div key={p.id}>
                {editingPreset && editingPreset !== 'new-recommended' && editingPreset.id === p.id ? (
                  <PresetForm
                    initial={{ name: p.name, conditions: p.conditions as StrategyConditions, trade: p.trade as TradeConfig }}
                    onSave={handleSaveRecommended}
                    onCancel={() => setEditingPreset(null)}
                    loading={presetLoading}
                  />
                ) : (
                  <div className="flex items-center justify-between p-3 bg-surface rounded-lg">
                    <div>
                      <span className="text-xs text-gray-500 mr-2">{i + 1}.</span>
                      <span className="text-sm text-gray-200 font-medium">{p.name}</span>
                      <div className="text-xs text-gray-500 mt-0.5">{presetSummary(p.conditions as StrategyConditions)}</div>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => { setEditingPreset(p); setPresetMsg(''); }}
                        className="text-xs text-gray-400 hover:text-gray-200 border border-border rounded px-2 py-0.5">
                        편집
                      </button>
                      <button onClick={() => handleDeletePreset(p.id)}
                        className="text-xs text-red-400 hover:text-red-300 border border-red-400/30 rounded px-2 py-0.5">
                        삭제
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {editingPreset === 'new-recommended' && (
              <PresetForm
                initial={{ name: '', conditions: DEFAULT_CONDITIONS, trade: DEFAULT_TRADE }}
                onSave={handleSaveRecommended}
                onCancel={() => setEditingPreset(null)}
                loading={presetLoading}
              />
            )}
          </div>
        </div>
      </div>

      {/* BTC 도미넌스 데이터 관리 */}
      <div className="bg-card border border-border rounded-xl p-4 mb-6">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">BTC 도미넌스 데이터</h2>

        {/* 자동 업데이트 안내 */}
        <div className="mb-3 p-2.5 bg-surface rounded-lg text-xs text-gray-400 space-y-0.5">
          <p className="text-gray-300 font-semibold mb-1">🕓 자동 업데이트: 매일 새벽 4:00 (서버 시간 기준)</p>
          <p>· 매일 최근 7일치 데이터를 자동 수집해 기존 CSV에 병합합니다</p>
          <p>· CoinGecko <strong className="text-gray-200">Demo</strong> 플랜: 11 calls/회 × 30일 = 330 calls/월 사용 (한도 여유)</p>
          <p>· <strong className="text-gray-200">Pro</strong> 플랜: <code className="bg-card px-1 rounded">/global/market_cap_chart</code> 직접 조회 (정확도 100%)</p>
          <p>· Demo 플랜: 상위 10개 코인 시총 합산 + 당일 실제값 보정 → 오차 ±3~5%</p>
        </div>

        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <div className="text-sm text-gray-400">
            {domInfo?.hasData
              ? <span className="text-green-400">{domInfo.count}개 · {domInfo.dateRange}</span>
              : <span className="text-gray-500">데이터 없음</span>}
          </div>
          <button onClick={handleDomFetch} disabled={domLoading}
            className="text-xs bg-accent text-black font-semibold px-3 py-1.5 rounded-lg hover:bg-accent/90 disabled:opacity-50">
            {domLoading ? '처리 중... (~4초)' : 'CoinGecko 지금 수집 (최근 1년)'}
          </button>
          {domInfo?.hasData && (
            <button onClick={handleDomDelete} disabled={domLoading}
              className="text-xs text-red-400 border border-red-400/30 px-3 py-1.5 rounded-lg hover:text-red-300 disabled:opacity-50">
              데이터 삭제
            </button>
          )}
        </div>
        <div className="space-y-2">
          <div className="text-xs text-gray-500">CSV 직접 업로드 (형식: date,dominance)</div>
          <textarea value={csvText} onChange={e => setCsvText(e.target.value)} rows={4}
            placeholder={"date,dominance\n2024-01-01,52.3\n2024-01-02,51.8"}
            className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-xs text-gray-300 font-mono focus:outline-none focus:border-accent resize-none" />
          <button onClick={handleDomUpload} disabled={domLoading || !csvText.trim()}
            className="text-xs bg-blue-500/20 text-blue-400 border border-blue-400/30 px-3 py-1.5 rounded-lg hover:bg-blue-500/30 disabled:opacity-50">
            CSV 업로드
          </button>
        </div>
        {domMsg && (
          <div className={`mt-2 text-xs px-3 py-2 rounded-lg ${
            domMsg.startsWith('오류')
              ? 'bg-red-400/10 text-red-400 border border-red-400/20'
              : 'bg-green-400/10 text-green-400 border border-green-400/20'
          }`}>{domMsg}</div>
        )}
      </div>

      {/* 사용자 목록 */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-300">사용자 목록</h2>
            {paperIds.size > 0 && (
              <span className="text-xs bg-green-500/15 text-green-400 border border-green-500/20 px-2 py-0.5 rounded-full">
                가상 {paperIds.size}개 실행 중
              </span>
            )}
            {liveIds.size > 0 && (
              <span className="text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 px-2 py-0.5 rounded-full">
                실거래 {liveIds.size}개 실행 중
              </span>
            )}
          </div>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="이메일 검색"
            className="bg-surface border border-border rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-accent w-48" />
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
                <th className="text-center py-2 pr-4">가상 스캐너</th>
                <th className="text-center py-2 pr-4">실거래 스캐너</th>
                <th className="text-right py-2">액션</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-gray-500">사용자 없음</td></tr>
              )}
              {filtered.map(u => {
                const paperRunning  = paperIds.has(u.id);
                const liveRunning   = liveIds.has(u.id);
                const paperToggling = scannerLoading === `paper-${u.id}`;
                const liveToggling  = scannerLoading === `live-${u.id}`;
                return (
                  <tr key={u.id} className="border-b border-border/50 hover:bg-white/3">
                    <td className="py-3 pr-4 text-gray-200">{u.email}</td>
                    <td className="py-3 pr-4 text-gray-400 whitespace-nowrap">
                      {new Date(u.createdAt).toLocaleDateString('ko')}
                    </td>
                    <td className="py-3 pr-4 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        u.hasApiKeys ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-500'
                      }`}>{u.hasApiKeys ? '등록' : '없음'}</span>
                    </td>
                    <td className="py-3 pr-4 text-center text-gray-300">{u.strategies}</td>
                    <td className="py-3 pr-4 text-center text-gray-300">{u.liveTrades}</td>
                    <td className="py-3 pr-4 text-right text-gray-300">
                      {u.paperBalance != null ? `$${u.paperBalance.toFixed(0)}` : '-'}
                    </td>
                    <td className="py-3 pr-4 text-center">
                      <button
                        onClick={() => handlePaperToggle(u.id)}
                        disabled={paperToggling || liveToggling}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                          paperRunning
                            ? 'bg-green-500/15 text-green-400 border-green-500/30 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/30'
                            : 'bg-gray-500/10 text-gray-500 border-gray-500/20 hover:bg-green-500/15 hover:text-green-400 hover:border-green-500/30'
                        }`}
                      >
                        {paperToggling ? '...' : paperRunning ? '● 실행 중' : '○ 중지'}
                      </button>
                    </td>
                    <td className="py-3 pr-4 text-center">
                      <button
                        onClick={() => handleLiveToggle(u.id)}
                        disabled={paperToggling || liveToggling}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                          liveRunning
                            ? 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30 hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/30'
                            : 'bg-gray-500/10 text-gray-500 border-gray-500/20 hover:bg-yellow-500/15 hover:text-yellow-400 hover:border-yellow-500/30'
                        }`}
                      >
                        {liveToggling ? '...' : liveRunning ? '● 실행 중' : '○ 중지'}
                      </button>
                    </td>
                    <td className="py-3 text-right">
                      <button onClick={() => handleDelete(u.id, u.email)}
                        className="text-xs text-red-400 hover:text-red-300 border border-red-400/30 rounded px-2 py-0.5">
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

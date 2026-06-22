import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { createStrategy, updateStrategy, getStrategies, deleteStrategy, toggleStrategy, validateStrategy, runBacktest, getPresets, AdminPreset } from '../utils/api';
import { ValidationResult, BacktestResult, StrategyConditions, TradeConfig } from '../types';

// ── 공통 입력 ────────────────────────────────────────────────

type EmptyTracker = React.MutableRefObject<Set<string>>;

function NumberInput({ label, value, onChange, fieldId, emptyTracker, min, max, unit = '' }: {
  label: string; value: number; onChange: (v: number) => void;
  fieldId?: string; emptyTracker?: EmptyTracker;
  min?: number; max?: number; unit?: string;
}) {
  const [raw, setRaw] = useState(() => isNaN(value) ? '' : String(value));

  useEffect(() => {
    const str = isNaN(value) ? '' : String(value);
    setRaw(str);
    if (fieldId && emptyTracker && !isNaN(value)) emptyTracker.current.delete(fieldId);
  }, [value]);

  useEffect(() => {
    return () => { if (fieldId && emptyTracker) emptyTracker.current.delete(fieldId); };
  }, []);

  const mark = (empty: boolean) => {
    if (!fieldId || !emptyTracker) return;
    if (empty) emptyTracker.current.add(fieldId);
    else emptyTracker.current.delete(fieldId);
  };

  return (
    <div>
      {label && <label className="label">{label}</label>}
      <div className="flex items-center gap-2">
        <input
          type="text" inputMode="decimal"
          className={`input ${raw === '' ? 'border-down/50 focus:border-down/70' : ''}`}
          value={raw} placeholder="숫자 입력"
          onChange={e => {
            const v = e.target.value;
            if (v === '' || /^-?\d*\.?\d*$/.test(v)) {
              setRaw(v);
              mark(v === '');
              if (v !== '') { const n = parseFloat(v); if (!isNaN(n)) onChange(n); }
            }
          }}
          onBlur={() => {
            if (raw === '') return;
            const n = parseFloat(raw);
            if (isNaN(n)) { setRaw(isNaN(value) ? '' : String(value)); mark(false); }
            else {
              let c = n;
              if (min !== undefined) c = Math.max(min, c);
              if (max !== undefined) c = Math.min(max, c);
              setRaw(String(c)); onChange(c); mark(false);
            }
          }}
        />
        {unit && <span className="text-xs text-gray-400 flex-shrink-0">{unit}</span>}
      </div>
    </div>
  );
}

function RangeInput({ label, minVal, maxVal, unit = '', onMinChange, onMaxChange, fieldIdMin, fieldIdMax, emptyTracker }: {
  label: string; minVal: number; maxVal: number;
  unit?: string;
  onMinChange: (v: number) => void; onMaxChange: (v: number) => void;
  fieldIdMin?: string; fieldIdMax?: string; emptyTracker?: EmptyTracker;
}) {
  const [rawMin, setRawMin] = useState(() => isNaN(minVal) ? '' : String(minVal));
  const [rawMax, setRawMax] = useState(() => isNaN(maxVal) ? '' : String(maxVal));

  useEffect(() => { setRawMin(isNaN(minVal) ? '' : String(minVal)); if (fieldIdMin && emptyTracker && !isNaN(minVal)) emptyTracker.current.delete(fieldIdMin); }, [minVal]);
  useEffect(() => { setRawMax(isNaN(maxVal) ? '' : String(maxVal)); if (fieldIdMax && emptyTracker && !isNaN(maxVal)) emptyTracker.current.delete(fieldIdMax); }, [maxVal]);

  useEffect(() => {
    return () => {
      if (emptyTracker) {
        if (fieldIdMin) emptyTracker.current.delete(fieldIdMin);
        if (fieldIdMax) emptyTracker.current.delete(fieldIdMax);
      }
    };
  }, []);

  const mark = (id: string | undefined, empty: boolean) => {
    if (!id || !emptyTracker) return;
    if (empty) emptyTracker.current.add(id); else emptyTracker.current.delete(id);
  };

  const makeHandlers = (
    raw: string, setRaw: (v: string) => void,
    fid: string | undefined, parentVal: number, onChg: (v: number) => void
  ) => ({
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (v === '' || /^-?\d*\.?\d*$/.test(v)) {
        setRaw(v); mark(fid, v === '');
        if (v !== '') { const n = parseFloat(v); if (!isNaN(n)) onChg(n); }
      }
    },
    onBlur: () => {
      if (raw === '') return;
      const n = parseFloat(raw);
      if (isNaN(n)) { setRaw(isNaN(parentVal) ? '' : String(parentVal)); mark(fid, false); }
      else { setRaw(String(n)); onChg(n); mark(fid, false); }
    }
  });

  const minHandlers = makeHandlers(rawMin, setRawMin, fieldIdMin, minVal, onMinChange);
  const maxHandlers = makeHandlers(rawMax, setRawMax, fieldIdMax, maxVal, onMaxChange);

  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input type="text" inputMode="decimal"
          className={`input ${rawMin === '' ? 'border-down/50 focus:border-down/70' : ''}`}
          value={rawMin} placeholder="숫자 입력"
          onChange={minHandlers.onChange} onBlur={minHandlers.onBlur} />
        <span className="text-gray-500 text-sm flex-shrink-0">~</span>
        <input type="text" inputMode="decimal"
          className={`input ${rawMax === '' ? 'border-down/50 focus:border-down/70' : ''}`}
          value={rawMax} placeholder="숫자 입력"
          onChange={maxHandlers.onChange} onBlur={maxHandlers.onBlur} />
        {unit && <span className="text-xs text-gray-400 flex-shrink-0">{unit}</span>}
      </div>
    </div>
  );
}

// ── 코인 상세 모달 ────────────────────────────────────────────

function CoinDetailModal({
  symbol, conditions, trade, onClose
}: {
  symbol: string;
  conditions: StrategyConditions;
  trade: TradeConfig;
  onClose: () => void;
}) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    runBacktest({
      symbol: symbol.endsWith('USDT') ? symbol : symbol + 'USDT',
      interval: conditions.rsi.timeframe,
      limit: 1500,
      conditions,
      trade,
      btcDominance: 50
    })
      .then(setResult)
      .catch(e => setError(e.response?.data?.error ?? e.message))
      .finally(() => setLoading(false));
  }, [symbol]);

  const isPositiveEV = (result?.expectedValuePct ?? 0) > 0;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div>
            <h3 className="font-bold text-gray-100 text-base">{symbol.replace('USDT', '')} 상세 백테스트</h3>
            <p className="text-xs text-gray-500 mt-0.5">{conditions.rsi.timeframe}봉 × 최근 1500 캔들</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl w-8 h-8 flex items-center justify-center">×</button>
        </div>

        <div className="p-5">
          {loading && (
            <div className="text-center py-10">
              <div className="inline-block w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-gray-400">백테스트 실행 중...</p>
            </div>
          )}
          {error && <p className="text-down text-sm">{error}</p>}
          {result && !loading && (
            <>
              {result.totalTrades === 0 ? (
                <p className="text-gray-400 text-sm text-center py-6">
                  이 코인에서 조건 충족 신호 없음<br />
                  <span className="text-xs text-gray-500 mt-1 block">조건 범위를 넓히거나 다른 타임프레임을 시도하세요</span>
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    {[
                      { label: '총 신호', value: `${result.totalTrades}회` },
                      { label: '승률', value: `${(result.winRate * 100).toFixed(1)}%`, color: result.winRate >= 0.5 ? 'text-up' : 'text-down' },
                      { label: '평균 수익', value: `+${result.avgProfitPct.toFixed(1)}%`, color: 'text-up' },
                      { label: '기댓값 EV', value: `${result.expectedValuePct >= 0 ? '+' : ''}${result.expectedValuePct.toFixed(2)}%`, color: isPositiveEV ? 'text-up' : 'text-down' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-surface rounded-lg p-3 text-center">
                        <div className={`text-lg font-bold num ${color ?? 'text-gray-100'}`}>{value}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1.5 max-h-60 overflow-y-auto">
                    <p className="text-xs text-gray-500 mb-2">개별 거래 내역</p>
                    {result.trades.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-xs p-2 bg-surface rounded-lg">
                        <span className="text-gray-400">{new Date(t.entryTime).toLocaleDateString('ko')}</span>
                        <span className="text-gray-400 num">${t.entryPrice.toFixed(4)} → ${t.exitPrice.toFixed(4)}</span>
                        <span className={`font-semibold num ${t.pnlPct > 0 ? 'text-up' : 'text-down'}`}>
                          {t.pnlPct > 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
                        </span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          t.exitReason === 'takeProfit'     ? 'bg-up/15 text-up' :
                          t.exitReason === 'stopLoss'       ? 'bg-down/15 text-down' :
                          'bg-border text-gray-400'
                        }`}>
                          {t.exitReason === 'takeProfit' ? '익절' : t.exitReason === 'stopLoss' ? '손절' : '타임아웃'}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 검증 결과 패널 ────────────────────────────────────────────

function ValidationPanel({ result, loading, conditions, trade }: {
  result: ValidationResult | null;
  loading: boolean;
  conditions: StrategyConditions;
  trade: TradeConfig;
}) {
  const [showPerCoin, setShowPerCoin] = useState(false);
  const [selectedCoin, setSelectedCoin] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="card text-center py-8">
        <div className="inline-block w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-gray-400">전체 알트코인 데이터 수집 중...</p>
        <p className="text-xs text-gray-500 mt-1">코인 수에 따라 20~60초 소요됩니다</p>
      </div>
    );
  }

  if (!result) return null;

  const isPositiveEV = result.expectedValuePct > 0;
  const winPct = (result.winRate * 100).toFixed(1);

  if (result.totalSignals === 0) {
    return (
      <div className="card border-warn/30 bg-warn/5">
        <p className="text-sm text-warn font-medium">신호 없음</p>
        <p className="text-xs text-gray-400 mt-1">{result.message}</p>
        <p className="text-xs text-gray-500 mt-2">
          분석한 코인: {result.coinsAnalyzed}개 (Binance USDT 페어 중 일 거래량 $200K 이상, 메이저 코인 제외)
        </p>
      </div>
    );
  }

  return (
    <>
      {selectedCoin && (
        <CoinDetailModal symbol={selectedCoin} conditions={conditions} trade={trade} onClose={() => setSelectedCoin(null)} />
      )}
      <div className={`card border ${isPositiveEV ? 'border-up/30 bg-up/5' : 'border-down/30 bg-down/5'}`}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="section-title">전략 성과 검증 결과</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Binance USDT 전체 페어 · {result.coinsAnalyzed}개 코인 · {result.interval}봉 최근 62일
            </p>
          </div>
          <span className={`text-xs font-bold px-2 py-1 rounded-full flex-shrink-0 ${isPositiveEV ? 'bg-up/20 text-up' : 'bg-down/20 text-down'}`}>
            {isPositiveEV ? '전략 유효' : '재검토 필요'}
          </span>
        </div>
        <div className={`text-sm font-medium mb-4 p-3 rounded-lg ${isPositiveEV ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
          조건이 과거에 <strong>{result.totalSignals}번</strong> 발생 →{' '}
          <strong>{result.wins}번</strong> 수익 · <strong>{result.totalSignals - result.wins}번</strong> 손실
          <span className="text-gray-400 font-normal"> (승률 {winPct}%)</span>
        </div>
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: '승률',      value: `${winPct}%`, color: result.winRate >= 0.5 ? 'text-up' : 'text-down' },
            { label: '평균 수익', value: `+${result.avgProfitPct.toFixed(1)}%`, color: 'text-up' },
            { label: '평균 손실', value: `-${result.avgLossPct.toFixed(1)}%`,   color: 'text-down' },
            { label: '기댓값 EV', value: `${result.expectedValuePct >= 0 ? '+' : ''}${result.expectedValuePct.toFixed(2)}%`, color: isPositiveEV ? 'text-up' : 'text-down' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-surface rounded-lg p-3 text-center">
              <div className={`text-lg font-bold num ${color}`}>{value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-gray-400 bg-surface rounded-lg p-3 mb-3">
          <span className="text-gray-300 font-semibold">베이지안 해석: </span>
          P(수익 | 조건 충족) = {result.wins}/{result.totalSignals} = {winPct}% &nbsp;|&nbsp;
          기댓값 = {winPct}% × {result.avgProfitPct.toFixed(1)}% − {(100 - +winPct).toFixed(1)}% × {result.avgLossPct.toFixed(1)}%
          {' '}= <span className={isPositiveEV ? 'text-up font-semibold' : 'text-down font-semibold'}>
            {result.expectedValuePct >= 0 ? '+' : ''}{result.expectedValuePct.toFixed(2)}% / 거래
          </span>
        </div>
        <button onClick={() => setShowPerCoin(v => !v)} className="text-xs text-accent hover:underline flex items-center gap-1">
          {showPerCoin ? '▲' : '▼'} 코인별 신호 상세 ({result.coinsWithSignal}개 코인)
          <span className="text-gray-500">· 클릭하면 상세 백테스트</span>
        </button>
        {showPerCoin && (
          <div className="mt-3 space-y-1.5">
            {result.perCoin.map(coin => (
              <button key={coin.symbol} onClick={() => setSelectedCoin(coin.symbol)}
                className="w-full flex items-center gap-3 hover:bg-white/5 rounded-lg p-1.5 transition-colors text-left">
                <span className="text-xs text-accent hover:underline w-24 flex-shrink-0 font-medium">{coin.symbol.replace('USDT', '')} →</span>
                <span className="text-xs text-gray-500 w-12 flex-shrink-0 num">{coin.signals}회</span>
                <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${coin.winRate >= 0.5 ? 'bg-up' : 'bg-down'}`} style={{ width: `${coin.winRate * 100}%` }} />
                </div>
                <span className={`text-xs font-bold num w-10 text-right flex-shrink-0 ${coin.winRate >= 0.5 ? 'text-up' : 'text-down'}`}>
                  {(coin.winRate * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── PDF 방식 자동 손절가 계산 (프론트 미리보기용) ─────────────────

function calcPdfSlPct(leverage: number, gridLevels: number, gridSpacing: number): number {
  const step = gridSpacing / 100 / leverage;
  let sumPrices = 1.0;
  let count = 1;
  for (let i = 0; i < gridLevels; i++) {
    const avg  = sumPrices / count;
    const next = avg * (1 + step);
    sumPrices += next;
    count++;
  }
  return (sumPrices / count) * (1 + step) * 100 - 100;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────

let defaultApplied = false;

export default function Strategy() {
  const {
    draftConditions, draftTrade, setDraftConditions, setDraftTrade,
    strategies, setStrategies,
    validationResult, setValidationResult, validating, setValidating
  } = useStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const emptyFields = useRef(new Set<string>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [strategyName, setStrategyName] = useState('기본 전략');
  const [saved, setSaved] = useState(false);
  const [recommended, setRecommended] = useState<AdminPreset[]>([]);
  const [showPresets, setShowPresets] = useState(false);
  const [applyMsg, setApplyMsg] = useState('');

  useEffect(() => {
    getStrategies().then(strats => {
      setStrategies(strats);
      // ?edit=id 파라미터로 편집 모드 진입
      const editId = searchParams.get('edit');
      if (editId) {
        const target = strats.find(s => s.id === editId);
        if (target) {
          setEditingId(editId);
          setStrategyName(target.name);
          setDraftConditions(target.conditions);
          setDraftTrade(target.trade);
          defaultApplied = true; // 기본값 덮어쓰기 방지
        }
      }
    }).catch(() => {});

    getPresets().then(({ default: def, recommended: rec }) => {
      setRecommended(rec);
      if (!defaultApplied && def) {
        defaultApplied = true;
        setDraftConditions(def.conditions as StrategyConditions);
        setDraftTrade(def.trade as TradeConfig);
        setStrategyName(def.name);
      }
    }).catch(() => {});
  }, []);

  function applyPreset(p: AdminPreset) {
    setDraftConditions(p.conditions as StrategyConditions);
    setDraftTrade(p.trade as TradeConfig);
    setStrategyName(p.name);
    setApplyMsg(`"${p.name}" 적용됨`);
    setShowPresets(false);
    setTimeout(() => setApplyMsg(''), 2000);
  }

  const setChange = (key: 'min' | 'max', v: number) =>
    setDraftConditions({ priceChange24h: { ...draftConditions.priceChange24h, [key]: v } });
  const setVol = (key: 'min' | 'max', v: number) =>
    setDraftConditions({ volumeMultiplier: { ...draftConditions.volumeMultiplier, [key]: v } });

  const checkEmpty = () => {
    if (emptyFields.current.size > 0) {
      alert('입력값이 비어있는 항목이 있습니다. 모든 값을 입력해주세요.');
      return true;
    }
    return false;
  };

  const handleValidate = async () => {
    if (checkEmpty()) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const result: ValidationResult = await validateStrategy({ conditions: draftConditions, trade: draftTrade });
      setValidationResult(result);
    } catch (e: any) {
      alert(`검증 오류: ${e.response?.data?.error ?? e.message}`);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    if (checkEmpty()) return;
    try {
      if (editingId) {
        await updateStrategy(editingId, { name: strategyName, conditions: draftConditions, trade: draftTrade });
      } else {
        await createStrategy({ name: strategyName, enabled: false, coins: [], conditions: draftConditions, trade: draftTrade });
      }
      setStrategies(await getStrategies());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(`저장 오류: ${e.response?.data?.error ?? e.message}`);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setSearchParams({});
    defaultApplied = false;
    // 기본 프리셋으로 복원
    getPresets().then(({ default: def }) => {
      if (def) {
        setDraftConditions(def.conditions as StrategyConditions);
        setDraftTrade(def.trade as TradeConfig);
        setStrategyName(def.name);
        defaultApplied = true;
      }
    }).catch(() => {});
  };

  const handleStartEdit = (s: (typeof strategies)[0]) => {
    setEditingId(s.id);
    setStrategyName(s.name);
    setDraftConditions(s.conditions);
    setDraftTrade(s.trade);
    setSearchParams({ edit: s.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = async (id: string) => {
    if (!confirm('전략을 삭제하시겠습니까?')) return;
    await deleteStrategy(id);
    setStrategies(strategies.filter(s => s.id !== id));
  };

  const handleToggle = async (id: string) => {
    const updated = await toggleStrategy(id);
    setStrategies(strategies.map(s => s.id === id ? updated : s));
  };

  const TF_LABEL: Record<string, string> = { '1h': '1시간봉', '4h': '4시간봉', '1d': '일봉' };
  const CHANGE_TF_LABEL: Record<string, string> = { '1h': '1시간', '4h': '4시간', '24h': '24시간' };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="page-title">전략 설정</h1>
        <p className="page-sub">숏 진입 조건과 그리드 파라미터를 설정하고 과거 성과를 검증합니다</p>
      </div>

      {/* 추천 전략 패널 */}
      {recommended.length > 0 && (
        <div className="card">
          <button onClick={() => setShowPresets(v => !v)} className="flex items-center justify-between w-full text-left">
            <div>
              <h2 className="section-title">추천 전략</h2>
              <p className="text-xs text-gray-500 mt-0.5">클릭하면 해당 전략으로 설정이 바뀝니다</p>
            </div>
            <span className="text-gray-500 text-sm">{showPresets ? '▲' : '▼'}</span>
          </button>
          {showPresets && (
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
              {recommended.map(p => (
                <button key={p.id} onClick={() => applyPreset(p)}
                  className="text-left p-3 bg-surface rounded-lg border border-border hover:border-accent/50 hover:bg-accent/5 transition-colors">
                  <div className="text-sm font-medium text-gray-200">{p.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    RSI ≥ {p.conditions.rsi.min} · {CHANGE_TF_LABEL[p.conditions.priceChangeTimeframe ?? '24h']} +{p.conditions.priceChange24h.min}% · {p.trade.leverage}x
                  </div>
                </button>
              ))}
            </div>
          )}
          {applyMsg && (
            <div className="mt-2 text-xs text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-3 py-1.5">{applyMsg}</div>
          )}
        </div>
      )}

      {/* 진입 조건 */}
      <div className="card space-y-5">
        <div>
          <h2 className="section-title">진입 조건</h2>
          <p className="text-xs text-gray-500 mt-1">아래 조건이 동시에 충족될 때 숏 진입 신호가 발생합니다 (AND 조건)</p>
        </div>

        {/* RSI + 봉 설정 */}
        <div className="flex flex-wrap gap-4 items-end">
          <div>
            <NumberInput
              label={`RSI (${draftConditions.rsi.period}일) 최솟값`}
              value={draftConditions.rsi.min}
              onChange={v => setDraftConditions({ rsi: { ...draftConditions.rsi, min: v } })}
              min={0} max={100} unit="이상"
              fieldId="rsi-min" emptyTracker={emptyFields}
            />
          </div>
          <div>
            <label className="label">RSI 기간</label>
            <select className="input w-24"
              value={draftConditions.rsi.period}
              onChange={e => setDraftConditions({ rsi: { ...draftConditions.rsi, period: +e.target.value } })}>
              {[5, 7, 14].map(p => <option key={p} value={p}>{p}일</option>)}
            </select>
          </div>
          <div>
            <label className="label">RSI 기준 봉</label>
            <select className="input w-28"
              value={draftConditions.rsi.timeframe}
              onChange={e => setDraftConditions({ rsi: { ...draftConditions.rsi, timeframe: e.target.value } })}>
              {['1h', '4h', '1d'].map(tf => <option key={tf} value={tf}>{TF_LABEL[tf]}</option>)}
            </select>
          </div>
        </div>

        {/* 가격 변화 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-end">
          <RangeInput label="가격 상승률" unit="%"
            minVal={draftConditions.priceChange24h.min} maxVal={draftConditions.priceChange24h.max}
            onMinChange={v => setChange('min', v)} onMaxChange={v => setChange('max', v)}
            fieldIdMin="change-min" fieldIdMax="change-max" emptyTracker={emptyFields} />
          <div>
            <label className="label">기준 시간</label>
            <div className="flex gap-1">
              {(['1h', '4h', '24h'] as const).map(tf => (
                <button key={tf}
                  onClick={() => setDraftConditions({ priceChangeTimeframe: tf })}
                  className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${
                    (draftConditions.priceChangeTimeframe ?? '24h') === tf
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-gray-400 hover:border-gray-500'
                  }`}>
                  {CHANGE_TF_LABEL[tf]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 볼륨 배수 */}
        <RangeInput label="볼륨 배수 (20일 평균 대비)" unit="x"
          minVal={draftConditions.volumeMultiplier.min} maxVal={draftConditions.volumeMultiplier.max}
          onMinChange={v => setVol('min', v)} onMaxChange={v => setVol('max', v)}
          fieldIdMin="vol-min" fieldIdMax="vol-max" emptyTracker={emptyFields} />

        {/* 체크박스 조건들 */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input type="checkbox" id="ma7" className="w-4 h-4 accent-accent"
              checked={draftConditions.priceAboveMa7 ?? false}
              onChange={e => setDraftConditions({ priceAboveMa7: e.target.checked })} />
            <label htmlFor="ma7" className="text-sm text-gray-300 cursor-pointer">
              MA7 위 코인만 <span className="text-gray-500 text-xs">(7일 단순이동평균 위)</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="ma20" className="w-4 h-4 accent-accent"
              checked={draftConditions.priceAboveMa20 ?? false}
              onChange={e => setDraftConditions({ priceAboveMa20: e.target.checked })} />
            <label htmlFor="ma20" className="text-sm text-gray-300 cursor-pointer">
              MA20 위 코인만 <span className="text-gray-500 text-xs">(20일 단순이동평균 위)</span>
            </label>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="bb" className="w-4 h-4 accent-accent"
              checked={draftConditions.priceAboveBB}
              onChange={e => setDraftConditions({ priceAboveBB: e.target.checked })} />
            <label htmlFor="bb" className="text-sm text-gray-300 cursor-pointer">
              볼린저 상단 돌파 코인만 <span className="text-gray-500 text-xs">(BB 20 상단 돌파 확인)</span>
            </label>
          </div>
          {/* BTC 도미넌스 조건 — 비활성 (나중에 추가 예정)
          <div className="flex items-center gap-3 opacity-40 pointer-events-none">
            <input type="checkbox" className="w-4 h-4" disabled />
            <label className="text-sm text-gray-500">
              BTC 도미넌스 ≤ {draftConditions.btcDominanceMax}% (비활성)
            </label>
          </div>
          */}
        </div>

        {/* 스코어 안내 */}
        <div className="text-xs text-gray-500 bg-surface rounded-lg p-3">
          스코어 배점: RSI 30 · 가격변화 25 · 볼륨 20 · MA7 5 · MA20 5 · BB 15 = 100점 → 100점 충족 시 신호
        </div>
      </div>

      {/* 그리드 거래 설정 */}
      <div className="card space-y-5">
        <h2 className="section-title">그리드 숏 거래 설정</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <NumberInput label="레버리지"          value={draftTrade.leverage}        onChange={v => setDraftTrade({ leverage: v })}        min={1} max={10}  unit="x"       fieldId="leverage"     emptyTracker={emptyFields} />
          <NumberInput label="초기 진입 금액"    value={draftTrade.entryAmountUsdt} onChange={v => setDraftTrade({ entryAmountUsdt: v })} min={10}          unit="USDT"    fieldId="entry-amt"    emptyTracker={emptyFields} />
          <NumberInput label="그리드 레벨 수"    value={draftTrade.gridLevels}      onChange={v => setDraftTrade({ gridLevels: v })}      min={1} max={20}               fieldId="grid-levels"  emptyTracker={emptyFields} />
          <NumberInput label="물타기 간격 (PDF)" value={draftTrade.gridSpacing}     onChange={v => setDraftTrade({ gridSpacing: v })}     min={1} max={200}              fieldId="grid-spacing" emptyTracker={emptyFields} />
          <NumberInput label="익절 목표"         value={draftTrade.takeProfitPct}   onChange={v => setDraftTrade({ takeProfitPct: v })}  min={1} max={100} unit="% 하락시" fieldId="take-profit"  emptyTracker={emptyFields} />
        </div>

        {/* 최대 보유 시간 (선택) */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input type="checkbox" id="useTimeout" className="w-4 h-4 accent-accent"
              checked={draftTrade.maxDurationHours !== null}
              onChange={e => setDraftTrade({ maxDurationHours: e.target.checked ? 72 : null })} />
            <label htmlFor="useTimeout" className="text-sm text-gray-300 cursor-pointer">
              최대 보유 시간 설정 <span className="text-gray-500 text-xs">(체크 해제 시 타임아웃 없음)</span>
            </label>
          </div>
          {draftTrade.maxDurationHours !== null && (
            <div className="ml-7">
              <NumberInput label="" value={draftTrade.maxDurationHours}
                onChange={v => setDraftTrade({ maxDurationHours: v })} min={1} max={720} unit="시간"
                fieldId="max-duration" emptyTracker={emptyFields} />
            </div>
          )}
        </div>

        {/* RSI 반전 청산 (선택) */}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <input type="checkbox" id="useRsiExit" className="w-4 h-4 accent-accent"
              checked={draftTrade.rsiExitThreshold !== null}
              onChange={e => setDraftTrade({ rsiExitThreshold: e.target.checked ? 40 : null })} />
            <label htmlFor="useRsiExit" className="text-sm text-gray-300 cursor-pointer">
              RSI 반전 시 조기 청산 <span className="text-gray-500 text-xs">(과매수 → 정상화 감지)</span>
            </label>
          </div>
          {draftTrade.rsiExitThreshold !== null && (
            <div className="ml-7">
              <NumberInput label="" value={draftTrade.rsiExitThreshold}
                onChange={v => setDraftTrade({ rsiExitThreshold: v })} min={10} max={60} unit="RSI 미만 시 청산"
                fieldId="rsi-exit" emptyTracker={emptyFields} />
            </div>
          )}
        </div>

        <div className="p-3 bg-surface rounded-lg text-xs text-gray-400 space-y-1">
          <p>PDF 방식: 평균 진입가 기준 <span className="text-gray-300 font-semibold">{(draftTrade.gridSpacing / draftTrade.leverage).toFixed(1)}%</span> 간격으로 숏 {draftTrade.gridLevels}개 추가 (레버리지 분할)</p>
          <p>자동 손절: 진입가 대비 약 <span className="text-down font-semibold">+{calcPdfSlPct(draftTrade.leverage, draftTrade.gridLevels, draftTrade.gridSpacing).toFixed(1)}%</span> 상승시 청산 (ISOLATED)</p>
          <p>총 최대 노출: <span className="text-gray-300 num">${draftTrade.entryAmountUsdt * (draftTrade.gridLevels + 1)}</span> USDT × {draftTrade.leverage}x</p>
        </div>
      </div>

      {/* 전략 성과 검증 */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="section-title">전략 성과 검증</h2>
            <p className="text-xs text-gray-500 mt-1">
              Binance 전체 알트코인 (일 거래량 $200K 이상)의 과거 데이터로 이 조건의 승률을 계산합니다
            </p>
          </div>
          <button onClick={handleValidate} disabled={validating} className="btn-outline flex-shrink-0 disabled:opacity-50">
            {validating ? '분석 중...' : '승률 검증'}
          </button>
        </div>
        <ValidationPanel result={validationResult} loading={validating} conditions={draftConditions} trade={draftTrade} />
      </div>

      {/* 저장 */}
      <div className={`card space-y-4 ${editingId ? 'border-accent/30 bg-accent/3' : ''}`}>
        <div className="flex items-center gap-2">
          <h2 className="section-title">{editingId ? '전략 수정' : '전략 저장'}</h2>
          {editingId && (
            <span className="text-xs bg-accent/15 text-accent border border-accent/25 px-2 py-0.5 rounded-full">편집 중</span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input type="text" className="input w-64" placeholder="전략 이름"
            value={strategyName} onChange={e => setStrategyName(e.target.value)} />
          <button onClick={handleSave} className="btn-primary">
            {saved ? '✓ 완료' : editingId ? '수정 저장' : '저장'}
          </button>
          {editingId && (
            <button onClick={handleCancelEdit} className="btn-ghost text-xs">
              취소 (새 전략 모드로)
            </button>
          )}
        </div>
        {strategies.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border">
            {strategies.map(s => (
              <div key={s.id} className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
                editingId === s.id ? 'bg-accent/8 border border-accent/25' : 'bg-surface'
              }`}>
                <div>
                  <span className="text-sm text-gray-200">{s.name}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    RSI ≥ {s.conditions.rsi.min} / {CHANGE_TF_LABEL[s.conditions.priceChangeTimeframe ?? '24h']} +{s.conditions.priceChange24h.min}% 이상
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${s.enabled ? 'text-up' : 'text-gray-500'}`}>
                    {s.enabled ? '● 실행 중' : '○ 중지'}
                  </span>
                  <button onClick={() => handleToggle(s.id)} className="btn-ghost text-xs py-1">
                    {s.enabled ? '중지' : '시작'}
                  </button>
                  <button
                    onClick={() => handleStartEdit(s)}
                    className={`btn-ghost text-xs py-1 ${editingId === s.id ? 'text-accent' : ''}`}
                  >
                    {editingId === s.id ? '편집 중' : '수정'}
                  </button>
                  <button onClick={() => handleDelete(s.id)} className="btn-ghost text-xs py-1 text-down">삭제</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

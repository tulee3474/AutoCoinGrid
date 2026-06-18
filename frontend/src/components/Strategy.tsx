import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { createStrategy, getStrategies, deleteStrategy, toggleStrategy, validateStrategy, runBacktest } from '../utils/api';
import { ValidationResult, BacktestResult, StrategyConditions, TradeConfig } from '../types';

// ── 공통 입력 ────────────────────────────────────────────────

function RangeInput({ label, minVal, maxVal, step = 1, unit = '', onMinChange, onMaxChange }: {
  label: string; minVal: number; maxVal: number;
  step?: number; unit?: string;
  onMinChange: (v: number) => void; onMaxChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" className="input" step={step} value={minVal} onChange={e => onMinChange(+e.target.value)} />
        <span className="text-gray-500 text-sm flex-shrink-0">~</span>
        <input type="number" className="input" step={step} value={maxVal} onChange={e => onMaxChange(+e.target.value)} />
        {unit && <span className="text-xs text-gray-400 flex-shrink-0">{unit}</span>}
      </div>
    </div>
  );
}

function NumberInput({ label, value, onChange, min, max, step = 1, unit = '' }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" className="input" step={step} min={min} max={max} value={value}
          onChange={e => onChange(+e.target.value)} />
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

  // 모달 열리면 즉시 백테스트 실행
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
        {/* 헤더 */}
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
                  {/* 요약 통계 */}
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    {[
                      { label: '총 신호', value: `${result.totalTrades}회` },
                      { label: '승률', value: `${(result.winRate * 100).toFixed(1)}%`,
                        color: result.winRate >= 0.5 ? 'text-up' : 'text-down' },
                      { label: '평균 수익', value: `+${result.avgProfitPct.toFixed(1)}%`, color: 'text-up' },
                      { label: '기댓값 EV', value: `${result.expectedValuePct >= 0 ? '+' : ''}${result.expectedValuePct.toFixed(2)}%`,
                        color: isPositiveEV ? 'text-up' : 'text-down' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-surface rounded-lg p-3 text-center">
                        <div className={`text-lg font-bold num ${color ?? 'text-gray-100'}`}>{value}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* 거래 내역 */}
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
                          t.exitReason === 'takeProfit' ? 'bg-up/15 text-up' :
                          t.exitReason === 'stopLoss'   ? 'bg-down/15 text-down' :
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

function ValidationPanel({
  result, loading, conditions, trade
}: {
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
        <CoinDetailModal
          symbol={selectedCoin}
          conditions={conditions}
          trade={trade}
          onClose={() => setSelectedCoin(null)}
        />
      )}

      <div className={`card border ${isPositiveEV ? 'border-up/30 bg-up/5' : 'border-down/30 bg-down/5'}`}>
        {/* 헤더 */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="section-title">전략 성과 검증 결과</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Binance USDT 전체 페어 중 일 거래량 $200K 이상 · {result.coinsAnalyzed}개 코인 · {result.interval}봉 최근 62일 데이터
            </p>
          </div>
          <span className={`text-xs font-bold px-2 py-1 rounded-full flex-shrink-0 ${isPositiveEV ? 'bg-up/20 text-up' : 'bg-down/20 text-down'}`}>
            {isPositiveEV ? '전략 유효' : '재검토 필요'}
          </span>
        </div>

        {/* 핵심 요약 */}
        <div className={`text-sm font-medium mb-4 p-3 rounded-lg ${isPositiveEV ? 'bg-up/10 text-up' : 'bg-down/10 text-down'}`}>
          조건이 과거에 <strong>{result.totalSignals}번</strong> 발생 →{' '}
          <strong>{result.wins}번</strong> 수익 · <strong>{result.totalSignals - result.wins}번</strong> 손실
          <span className="text-gray-400 font-normal"> (승률 {winPct}%)</span>
        </div>

        {/* 통계 4개 */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: '승률',      value: `${winPct}%`,
              color: result.winRate >= 0.5 ? 'text-up' : 'text-down' },
            { label: '평균 수익', value: `+${result.avgProfitPct.toFixed(1)}%`, color: 'text-up' },
            { label: '평균 손실', value: `-${result.avgLossPct.toFixed(1)}%`,   color: 'text-down' },
            { label: '기댓값 EV', value: `${result.expectedValuePct >= 0 ? '+' : ''}${result.expectedValuePct.toFixed(2)}%`,
              color: isPositiveEV ? 'text-up' : 'text-down' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-surface rounded-lg p-3 text-center">
              <div className={`text-lg font-bold num ${color}`}>{value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* 베이지안 해석 */}
        <div className="text-xs text-gray-400 bg-surface rounded-lg p-3 mb-3">
          <span className="text-gray-300 font-semibold">베이지안 해석: </span>
          P(수익 | 조건 충족) = {result.wins}/{result.totalSignals} = {winPct}% &nbsp;|&nbsp;
          기댓값 = {winPct}% × {result.avgProfitPct.toFixed(1)}% − {(100 - +winPct).toFixed(1)}% × {result.avgLossPct.toFixed(1)}%
          {' '}= <span className={isPositiveEV ? 'text-up font-semibold' : 'text-down font-semibold'}>
            {result.expectedValuePct >= 0 ? '+' : ''}{result.expectedValuePct.toFixed(2)}% / 거래
          </span>
        </div>

        {/* 코인별 상세 */}
        <button
          onClick={() => setShowPerCoin(v => !v)}
          className="text-xs text-accent hover:underline flex items-center gap-1"
        >
          {showPerCoin ? '▲' : '▼'} 코인별 신호 상세 ({result.coinsWithSignal}개 코인)
          <span className="text-gray-500">· 클릭하면 상세 백테스트</span>
        </button>

        {showPerCoin && (
          <div className="mt-3 space-y-1.5">
            {result.perCoin.map(coin => (
              <button
                key={coin.symbol}
                onClick={() => setSelectedCoin(coin.symbol)}
                className="w-full flex items-center gap-3 hover:bg-white/5 rounded-lg p-1.5 transition-colors text-left"
              >
                <span className="text-xs text-accent hover:underline w-24 flex-shrink-0 font-medium">
                  {coin.symbol.replace('USDT', '')} →
                </span>
                <span className="text-xs text-gray-500 w-12 flex-shrink-0 num">{coin.signals}회</span>
                <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${coin.winRate >= 0.5 ? 'bg-up' : 'bg-down'}`}
                    style={{ width: `${coin.winRate * 100}%` }}
                  />
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

// ── 메인 컴포넌트 ─────────────────────────────────────────────

export default function Strategy() {
  const {
    draftConditions, draftTrade, setDraftConditions, setDraftTrade,
    strategies, setStrategies,
    validationResult, setValidationResult, validating, setValidating
  } = useStore();
  const [strategyName, setStrategyName] = useState('기본 전략');
  const [saved, setSaved] = useState(false);

  const setRsi    = (key: 'min' | 'max', v: number) =>
    setDraftConditions({ rsi: { ...draftConditions.rsi, [key]: v } });
  const setChange = (key: 'min' | 'max', v: number) =>
    setDraftConditions({ priceChange24h: { ...draftConditions.priceChange24h, [key]: v } });
  const setVol    = (key: 'min' | 'max', v: number) =>
    setDraftConditions({ volumeMultiplier: { ...draftConditions.volumeMultiplier, [key]: v } });

  const handleValidate = async () => {
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
    try {
      await createStrategy({ name: strategyName, enabled: false, coins: [], conditions: draftConditions, trade: draftTrade });
      setStrategies(await getStrategies());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      alert(`저장 오류: ${e.response?.data?.error ?? e.message}`);
    }
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

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="page-title">전략 설정</h1>
        <p className="page-sub">숏 진입 조건과 그리드 파라미터를 설정하고 과거 성과를 검증합니다</p>
      </div>

      {/* 진입 조건 */}
      <div className="card space-y-5">
        <div>
          <h2 className="section-title">진입 조건</h2>
          <p className="text-xs text-gray-500 mt-1">아래 조건이 동시에 충족될 때 숏 진입 신호가 발생합니다 (AND 조건)</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <RangeInput label="RSI (14) 범위"
            minVal={draftConditions.rsi.min} maxVal={draftConditions.rsi.max}
            onMinChange={v => setRsi('min', v)} onMaxChange={v => setRsi('max', v)} />
          <RangeInput label="24시간 가격 상승률" unit="%"
            minVal={draftConditions.priceChange24h.min} maxVal={draftConditions.priceChange24h.max}
            onMinChange={v => setChange('min', v)} onMaxChange={v => setChange('max', v)} />
          <RangeInput label="볼륨 배수 (평균 대비)" step={0.5} unit="x"
            minVal={draftConditions.volumeMultiplier.min} maxVal={draftConditions.volumeMultiplier.max}
            onMinChange={v => setVol('min', v)} onMaxChange={v => setVol('max', v)} />
          <NumberInput label="BTC 도미넌스 최대"
            value={draftConditions.btcDominanceMax}
            onChange={v => setDraftConditions({ btcDominanceMax: v })}
            min={20} max={90} unit="%" />
        </div>
        <div>
          <label className="label">RSI 기준 타임프레임</label>
          <select className="input w-36"
            value={draftConditions.rsi.timeframe}
            onChange={e => setDraftConditions({ rsi: { ...draftConditions.rsi, timeframe: e.target.value } })}>
            {['15m','30m','1h','4h','1d'].map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <input type="checkbox" id="ma200" className="w-4 h-4 accent-accent"
            checked={draftConditions.priceAboveMa200}
            onChange={e => setDraftConditions({ priceAboveMa200: e.target.checked })} />
          <label htmlFor="ma200" className="text-sm text-gray-300 cursor-pointer">
            MA200 위 코인만 <span className="text-gray-500 text-xs">(펌핑 확인)</span>
          </label>
        </div>
      </div>

      {/* 그리드 거래 설정 */}
      <div className="card space-y-5">
        <div>
          <h2 className="section-title">그리드 숏 거래 설정</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <NumberInput label="레버리지"        value={draftTrade.leverage}          onChange={v => setDraftTrade({ leverage: v })}          min={1}  max={10}  unit="x" />
          <NumberInput label="초기 진입 금액"  value={draftTrade.entryAmountUsdt}   onChange={v => setDraftTrade({ entryAmountUsdt: v })}   min={10}           unit="USDT" />
          <NumberInput label="그리드 레벨 수"  value={draftTrade.gridLevels}        onChange={v => setDraftTrade({ gridLevels: v })}        min={1}  max={20} />
          <NumberInput label="그리드 간격"     value={draftTrade.gridSpacing}       onChange={v => setDraftTrade({ gridSpacing: v })}       min={1}  max={50}  unit="%" />
          <NumberInput label="익절 목표"       value={draftTrade.takeProfitPct}     onChange={v => setDraftTrade({ takeProfitPct: v })}     min={1}  max={100} unit="% 하락시" />
          <NumberInput label="손절 기준"       value={draftTrade.stopLossPct}       onChange={v => setDraftTrade({ stopLossPct: v })}       min={1}  max={100} unit="% 상승시" />
          <NumberInput label="최대 보유 시간"  value={draftTrade.maxDurationHours}  onChange={v => setDraftTrade({ maxDurationHours: v })}  min={1}  max={720} unit="시간" />
        </div>
        <div className="p-3 bg-surface rounded-lg text-xs text-gray-400 space-y-1">
          <p>진입가 위로 <span className="text-gray-300 font-semibold">{draftTrade.gridSpacing}%</span> 간격마다 숏 {draftTrade.gridLevels}개 추가</p>
          <p>총 최대 노출: <span className="text-gray-300 num">${draftTrade.entryAmountUsdt * (draftTrade.gridLevels + 1)}</span> USDT × {draftTrade.leverage}x</p>
        </div>
      </div>

      {/* 전략 성과 검증 */}
      <div className="card space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="section-title">전략 성과 검증</h2>
            <p className="text-xs text-gray-500 mt-1">
              Binance 전체 알트코인 (일 거래량 $200K 이상, 메이저 코인 제외)의 과거 데이터로 이 조건의 승률을 계산합니다
            </p>
          </div>
          <button onClick={handleValidate} disabled={validating}
            className="btn-outline flex-shrink-0 disabled:opacity-50">
            {validating ? '분석 중...' : '승률 검증'}
          </button>
        </div>
        <ValidationPanel
          result={validationResult}
          loading={validating}
          conditions={draftConditions}
          trade={draftTrade}
        />
      </div>

      {/* 저장 */}
      <div className="card space-y-4">
        <h2 className="section-title">전략 저장</h2>
        <div className="flex items-center gap-3">
          <input type="text" className="input w-64" placeholder="전략 이름"
            value={strategyName} onChange={e => setStrategyName(e.target.value)} />
          <button onClick={handleSave} className="btn-primary">{saved ? '✓ 저장됨' : '저장'}</button>
        </div>
        {strategies.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-border">
            {strategies.map(s => (
              <div key={s.id} className="flex items-center justify-between p-3 bg-surface rounded-lg">
                <div>
                  <span className="text-sm text-gray-200">{s.name}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    RSI {s.conditions.rsi.min}~{s.conditions.rsi.max} / +{s.conditions.priceChange24h.min}% 이상
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${s.enabled ? 'text-up' : 'text-gray-500'}`}>
                    {s.enabled ? '● 실행 중' : '○ 중지'}
                  </span>
                  <button onClick={() => handleToggle(s.id)} className="btn-ghost text-xs py-1">
                    {s.enabled ? '중지' : '시작'}
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

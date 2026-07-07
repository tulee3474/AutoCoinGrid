import { useState, useEffect, useCallback, FormEvent } from 'react';
import {
  adminLogin, getAdminStats, getAdminUsers, deleteAdminUser, getAdminUser,
  getAdminScanners,
  adminStartPaperScanner, adminStopPaperScanner,
  adminStartLiveScanner, adminStopLiveScanner,
  getBtcDomDataInfo, fetchBtcDomFromCoinGecko, uploadBtcDomCSV, deleteBtcDomData,
  getPresets, adminCreatePreset, adminUpdatePreset, adminDeletePreset,
  AdminUser, AdminPreset
} from '../utils/api';
import { StrategyConditions, TradeConfig, DEFAULT_CONDITIONS, DEFAULT_TRADE } from '../types';

interface UserDetail {
  id: string;
  email: string;
  hasApiKeys: boolean;
  strategies: Array<{
    id: string; name: string; enabled: boolean;
    coins: string[]; conditions: any; trade: any;
  }>;
  livePositions: Array<{
    id: string; symbol: string; qty: number; entryPrice: number;
    takeProfitPrice: number; stopLossPrice: number; leverage: number;
    entryAmountUsdt: number; strategyName: string; openedAt: string;
    markPrice: number | null; unrealizedPnlUsdt: number | null;
  }>;
  liveRealizedPnl: number;
  liveTrades: number;
  liveAccountBalance: {
    totalWalletBalance: number;
    availableBalance: number;
    totalUnrealizedProfit: number;
    totalMarginBalance: number;
  } | null;
  paperWallet: {
    balance: number;
    initialBalance: number;
    openPositions: Array<{
      id: string; symbol: string; entryPrice: number; avgEntryPrice: number;
      totalEntryUsdt: number; gridsFilled: number; takeProfitPrice: number;
      stopLossPrice: number; leverage: number; entryAmountUsdt: number;
      strategyName: string; openedAt: string;
      markPrice: number | null; unrealizedPnlUsdt: number | null;
    }>;
  } | null;
  paperRealizedPnl: number;
  paperTrades: number;
}

function UserDetailPanel({ detail }: { detail: UserDetail }) {
  const [expandedStrategyIds, setExpandedStrategyIds] = useState<Set<string>>(new Set());

  const toggleStrategy = (id: string) =>
    setExpandedStrategyIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const strategies     = detail.strategies ?? [];
  const livePositions  = detail.livePositions ?? [];
  const paperPositions = detail.paperWallet?.openPositions ?? [];

  const liveUnrealizedTotal  = livePositions.reduce((s, p)  => s + (p.unrealizedPnlUsdt  ?? 0), 0);
  const paperUnrealizedTotal = paperPositions.reduce((s, p) => s + (p.unrealizedPnlUsdt ?? 0), 0);

  const fmt = (v: number) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
  const cls = (v: number) => v >= 0 ? 'text-up' : 'text-down';

  const hasLiveActivity  = livePositions.length  > 0 || detail.liveRealizedPnl  !== 0;
  const hasPaperActivity = paperPositions.length > 0 || detail.paperRealizedPnl !== 0;

  return (
    <div className="mx-2 mb-2 p-4 bg-surface rounded-xl border border-border/50 space-y-5">

      {/* ── 수익 현황 ───────────────────────────────── */}
      {(hasLiveActivity || hasPaperActivity) && (
        <div>
          <div className="text-xs font-semibold text-gray-400 mb-2">수익 현황</div>
          <div className="grid grid-cols-2 gap-3">
            {hasLiveActivity && (
              <div className="bg-card rounded-lg p-3 space-y-1.5">
                <div className="text-xs text-yellow-400 font-semibold mb-1">실거래 ({detail.liveTrades}건)</div>
                {detail.liveAccountBalance && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">총 자산 (Binance)</span>
                    <span className="text-gray-200 font-semibold">${detail.liveAccountBalance.totalMarginBalance.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">실현 손익</span>
                  <span className={cls(detail.liveRealizedPnl)}>{fmt(detail.liveRealizedPnl)}</span>
                </div>
                {livePositions.length > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">미실현 ({livePositions.length}개)</span>
                    <span className={cls(liveUnrealizedTotal)}>{fmt(liveUnrealizedTotal)}</span>
                  </div>
                )}
                <div className="border-t border-border/30 pt-1.5 flex justify-between text-xs">
                  <span className="text-gray-400 font-semibold">합계</span>
                  <span className={`font-semibold ${cls(detail.liveRealizedPnl + liveUnrealizedTotal)}`}>
                    {fmt(detail.liveRealizedPnl + liveUnrealizedTotal)}
                  </span>
                </div>
              </div>
            )}
            {hasPaperActivity && (
              <div className="bg-card rounded-lg p-3 space-y-1.5">
                <div className="text-xs text-blue-400 font-semibold mb-1">가상 ({detail.paperTrades}건)</div>
                {detail.paperWallet && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">총 자산 (Equity)</span>
                    <span className={`font-semibold ${cls(detail.paperWallet.balance + paperUnrealizedTotal - detail.paperWallet.initialBalance)}`}>
                      ${(detail.paperWallet.balance + paperUnrealizedTotal).toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">실현 손익</span>
                  <span className={cls(detail.paperRealizedPnl)}>{fmt(detail.paperRealizedPnl)}</span>
                </div>
                {paperPositions.length > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">미실현 ({paperPositions.length}개)</span>
                    <span className={cls(paperUnrealizedTotal)}>{fmt(paperUnrealizedTotal)}</span>
                  </div>
                )}
                <div className="border-t border-border/30 pt-1.5 flex justify-between text-xs">
                  <span className="text-gray-400 font-semibold">합계</span>
                  <span className={`font-semibold ${cls(detail.paperRealizedPnl + paperUnrealizedTotal)}`}>
                    {fmt(detail.paperRealizedPnl + paperUnrealizedTotal)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 전략 ────────────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-400 mb-2">전략 ({strategies.length}개)</div>
        {strategies.length === 0 ? (
          <div className="text-xs text-gray-600 px-1">전략 없음</div>
        ) : (
          <div className="space-y-1.5">
            {strategies.map(s => {
              const c = s.conditions as StrategyConditions;
              const t = s.trade as TradeConfig;
              const coins = Array.isArray(s.coins) ? s.coins as string[] : [];
              const isExp = expandedStrategyIds.has(s.id);
              return (
                <div key={s.id} className="bg-card rounded-lg overflow-hidden">
                  <button onClick={() => toggleStrategy(s.id)}
                    className="w-full flex items-center gap-2.5 p-2.5 hover:bg-white/5 transition-colors text-left">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.enabled ? 'bg-green-400' : 'bg-gray-600'}`} />
                    <span className="text-sm text-gray-200 font-medium flex-1 truncate">{s.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${s.enabled ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-500'}`}>
                      {s.enabled ? '활성' : '비활성'}
                    </span>
                    <span className="text-xs text-gray-500 flex-shrink-0 hidden sm:block">
                      RSI {c?.rsi?.min}~{c?.rsi?.max} ({c?.rsi?.timeframe}) · 코인 {coins.length}개
                    </span>
                    <span className="text-xs text-gray-600 flex-shrink-0">{isExp ? '▲' : '▼'}</span>
                  </button>

                  {isExp && (
                    <div className="border-t border-border/30 px-3 pb-3 pt-2.5 space-y-3">
                      <div>
                        <div className="text-xs text-gray-500 font-semibold mb-1.5">진입 조건</div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                          <div><span className="text-gray-600">RSI </span><span className="text-gray-300">{c?.rsi?.min}~{c?.rsi?.max} ({c?.rsi?.period}일, {c?.rsi?.timeframe}봉)</span></div>
                          <div><span className="text-gray-600">24h 상승률 </span><span className="text-gray-300">+{c?.priceChange24h?.min}%~+{c?.priceChange24h?.max}%</span></div>
                          <div><span className="text-gray-600">볼륨 배수 </span><span className="text-gray-300">{c?.volumeMultiplier?.min}x~{c?.volumeMultiplier?.max}x</span></div>
                          <div><span className="text-gray-600">가격변화 기준 </span><span className="text-gray-300">{c?.priceChangeTimeframe}</span></div>
                          <div><span className="text-gray-600">MA7 위 </span><span className="text-gray-300">{c?.priceAboveMa7 ? '✓' : '✗'}</span></div>
                          <div><span className="text-gray-600">MA20 위 </span><span className="text-gray-300">{c?.priceAboveMa20 ? '✓' : '✗'}</span></div>
                          <div><span className="text-gray-600">볼린저 상단 </span><span className="text-gray-300">{c?.priceAboveBB ? '✓' : '✗'}</span></div>
                          <div><span className="text-gray-600">BTC 도미넌스 </span><span className="text-gray-300">&lt;{c?.btcDominanceMax}%</span></div>
                          <div><span className="text-gray-600">상장 초기 제외 </span><span className="text-gray-300">{c?.minListingDays != null ? `${c.minListingDays}일 미만` : '비활성'}</span></div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 font-semibold mb-1.5">거래 설정</div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                          <div><span className="text-gray-600">레버리지 </span><span className="text-gray-300">{t?.leverage}x</span></div>
                          <div><span className="text-gray-600">진입 금액 </span><span className="text-gray-300">${t?.entryAmountUsdt}</span></div>
                          <div><span className="text-gray-600">그리드 DCA </span><span className="text-gray-300">{t?.gridEnabled !== false ? '사용' : '미사용'}</span></div>
                          {t?.gridEnabled !== false
                            ? <>
                                <div><span className="text-gray-600">그리드 레벨 </span><span className="text-gray-300">{t?.gridLevels}단계</span></div>
                                <div><span className="text-gray-600">물타기 간격 </span><span className="text-gray-300">{t?.gridSpacing}% (PDF)</span></div>
                              </>
                            : <div><span className="text-gray-600">손절 </span><span className="text-gray-300">+{t?.stopLossPct}% 상승시</span></div>
                          }
                          <div><span className="text-gray-600">익절 </span><span className="text-gray-300">-{t?.takeProfitPct}% 하락시</span></div>
                          <div><span className="text-gray-600">최대 보유 </span><span className="text-gray-300">{t?.maxDurationHours != null ? `${t.maxDurationHours}시간` : '제한 없음'}</span></div>
                          <div><span className="text-gray-600">RSI 반전 청산 </span><span className="text-gray-300">{t?.rsiExitThreshold != null ? `RSI ${t.rsiExitThreshold} 미만` : '비활성'}</span></div>
                          <div><span className="text-gray-600">재진입 쿨다운 </span><span className="text-gray-300">{t?.reEntryCooldownHours != null ? `${t.reEntryCooldownHours}시간` : '비활성'}</span></div>
                          <div><span className="text-gray-600">그리드 RSI 과열 포기 </span><span className="text-gray-300">{t?.gridRsiSkipThreshold != null ? `RSI ${t.gridRsiSkipThreshold} 이상` : '비활성'}</span></div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 font-semibold mb-1.5">코인 ({coins.length}개)</div>
                        <div className="flex flex-wrap gap-1">
                          {coins.map(coin => (
                            <span key={coin} className="text-xs bg-border/60 text-gray-400 px-1.5 py-0.5 rounded">
                              {coin.replace('USDT', '')}
                            </span>
                          ))}
                          {coins.length === 0 && <span className="text-xs text-gray-600">코인 미지정</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── 오픈 포지션 ─────────────────────────────── */}
      <div>
        <div className="text-xs font-semibold text-gray-400 mb-2">
          오픈 포지션 (실거래 {livePositions.length} · 가상 {paperPositions.length})
        </div>
        {livePositions.length === 0 && paperPositions.length === 0 ? (
          <div className="text-xs text-gray-600 px-1">오픈 포지션 없음</div>
        ) : (
          <div className="space-y-2">
            {livePositions.map(p => (
              <div key={p.id} className="bg-card rounded-lg p-2.5 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 px-1.5 py-0.5 rounded">실거래</span>
                  <span className="text-sm font-bold text-gray-100">{p.symbol.replace('USDT', '')}</span>
                  <span className="text-xs text-gray-500">{p.leverage}x SHORT</span>
                  <span className="text-xs text-gray-600 ml-auto truncate max-w-32">{p.strategyName}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><div className="text-gray-600 mb-0.5">진입가</div><div className="text-gray-300">${p.entryPrice.toFixed(4)}</div></div>
                  {p.markPrice !== null && <div><div className="text-gray-600 mb-0.5">현재가</div><div className="text-gray-200">${p.markPrice.toFixed(4)}</div></div>}
                  {p.unrealizedPnlUsdt !== null && (
                    <div>
                      <div className="text-gray-600 mb-0.5">미실현 손익</div>
                      <div className={`font-semibold ${cls(p.unrealizedPnlUsdt)}`}>{fmt(p.unrealizedPnlUsdt)}</div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div><span className="text-gray-600">TP </span><span className="text-up">${p.takeProfitPrice.toFixed(4)}</span></div>
                  <div><span className="text-gray-600">SL </span><span className="text-down">${p.stopLossPrice.toFixed(4)}</span></div>
                  <div><span className="text-gray-600">수량 </span><span className="text-gray-300">{p.qty}</span></div>
                </div>
              </div>
            ))}
            {paperPositions.map(p => {
              const avgEntry = p.avgEntryPrice > 0 ? p.avgEntryPrice : p.entryPrice;
              return (
                <div key={p.id} className="bg-card rounded-lg p-2.5 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs bg-blue-500/15 text-blue-400 border border-blue-500/20 px-1.5 py-0.5 rounded">가상</span>
                    <span className="text-sm font-bold text-gray-100">{p.symbol.replace('USDT', '')}</span>
                    <span className="text-xs text-gray-500">{p.leverage}x SHORT</span>
                    {p.gridsFilled > 0 && <span className="text-xs text-gray-500">그리드 {p.gridsFilled}회</span>}
                    <span className="text-xs text-gray-600 ml-auto truncate max-w-32">{p.strategyName}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><div className="text-gray-600 mb-0.5">진입가</div><div className="text-gray-300">${p.entryPrice.toFixed(4)}</div></div>
                    {p.gridsFilled > 0 && <div><div className="text-gray-600 mb-0.5">평균 진입가</div><div className="text-gray-300">${avgEntry.toFixed(4)}</div></div>}
                    {p.markPrice !== null && <div><div className="text-gray-600 mb-0.5">현재가</div><div className="text-gray-200">${p.markPrice.toFixed(4)}</div></div>}
                    {p.unrealizedPnlUsdt !== null && (
                      <div>
                        <div className="text-gray-600 mb-0.5">미실현 손익</div>
                        <div className={`font-semibold ${cls(p.unrealizedPnlUsdt)}`}>{fmt(p.unrealizedPnlUsdt)}</div>
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span className="text-gray-600">TP </span><span className="text-up">${p.takeProfitPrice.toFixed(4)}</span></div>
                    <div><span className="text-gray-600">SL </span><span className="text-down">${p.stopLossPrice.toFixed(4)}</span></div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [c, setC] = useState<StrategyConditions>({
    ...DEFAULT_CONDITIONS,
    ...initial.conditions,
    priceChangeTimeframe: (initial.conditions as any).priceChangeTimeframe ?? DEFAULT_CONDITIONS.priceChangeTimeframe,
    priceAboveMa7:        (initial.conditions as any).priceAboveMa7        ?? DEFAULT_CONDITIONS.priceAboveMa7,
    priceAboveMa20:       (initial.conditions as any).priceAboveMa20       ?? DEFAULT_CONDITIONS.priceAboveMa20,
    minListingDays:       (initial.conditions as any).minListingDays !== undefined ? (initial.conditions as any).minListingDays : null,
  });
  const [t, setT] = useState<TradeConfig>({
    ...DEFAULT_TRADE,
    ...initial.trade,
    rsiExitThreshold: initial.trade.rsiExitThreshold !== undefined ? initial.trade.rsiExitThreshold : null,
    maxDurationHours:  initial.trade.maxDurationHours  !== undefined ? initial.trade.maxDurationHours  : null,
    reEntryCooldownHours: initial.trade.reEntryCooldownHours !== undefined ? initial.trade.reEntryCooldownHours : null,
    gridRsiSkipThreshold: initial.trade.gridRsiSkipThreshold !== undefined ? initial.trade.gridRsiSkipThreshold : null,
  });

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
          <F label="가격변화 기준 시간">
            <div className="flex gap-1 mt-0.5">
              {(['1h', '4h', '24h'] as const).map(tf => (
                <button key={tf} type="button"
                  onClick={() => sc({ priceChangeTimeframe: tf })}
                  className={`flex-1 py-1 text-xs rounded border transition-colors ${
                    c.priceChangeTimeframe === tf
                      ? 'border-accent bg-accent/20 text-accent'
                      : 'border-border text-gray-400 hover:border-gray-500'
                  }`}>{tf}</button>
              ))}
            </div>
          </F>
          <F label="MA7 위 코인만">
            <div className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={c.priceAboveMa7 ?? false}
                onChange={e => sc({ priceAboveMa7: e.target.checked })}
                className="w-4 h-4 accent-accent" />
              <span className="text-xs text-gray-300">사용</span>
            </div>
          </F>
          <F label="MA20 위 코인만">
            <div className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={c.priceAboveMa20 ?? false}
                onChange={e => sc({ priceAboveMa20: e.target.checked })}
                className="w-4 h-4 accent-accent" />
              <span className="text-xs text-gray-300">사용</span>
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
          <F label="상장 초기 코인 제외">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={c.minListingDays != null}
                onChange={e => sc({ minListingDays: e.target.checked ? 30 : null })}
                className="w-4 h-4 accent-accent flex-shrink-0" />
              {c.minListingDays != null && (
                <input type="number" value={c.minListingDays}
                  onChange={e => sc({ minListingDays: +e.target.value })}
                  className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
              )}
              {c.minListingDays != null && <span className="text-xs text-gray-500 flex-shrink-0">일 미만 제외</span>}
              {c.minListingDays == null && <span className="text-xs text-gray-500">비활성</span>}
            </div>
          </F>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-gray-400">거래 설정</div>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" className="w-3.5 h-3.5 accent-accent"
              checked={t.gridEnabled !== false}
              onChange={e => st({ gridEnabled: e.target.checked })} />
            <span className="text-xs text-gray-300">그리드 DCA</span>
          </label>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Num label="레버리지" unit="x" value={t.leverage} onChange={v => st({ leverage: v })} />
          <Num label="진입 금액" unit="USDT" value={t.entryAmountUsdt} onChange={v => st({ entryAmountUsdt: v })} />
          {t.gridEnabled !== false ? (
            <>
              <Num label="그리드 레벨" value={t.gridLevels} onChange={v => st({ gridLevels: v })} />
              <Num label="물타기 간격 (PDF)" value={t.gridSpacing} onChange={v => st({ gridSpacing: v })} />
            </>
          ) : (
            <Num label="손절 %" unit="% 상승시" value={t.stopLossPct} onChange={v => st({ stopLossPct: v })} />
          )}
          <Num label="익절" unit="% 하락시" value={t.takeProfitPct} onChange={v => st({ takeProfitPct: v })} />
          <F label="최대 보유">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={t.maxDurationHours !== null}
                onChange={e => st({ maxDurationHours: e.target.checked ? 72 : null })}
                className="w-4 h-4 accent-accent flex-shrink-0" />
              {t.maxDurationHours !== null && (
                <input type="number" value={t.maxDurationHours}
                  onChange={e => st({ maxDurationHours: +e.target.value })}
                  className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
              )}
              {t.maxDurationHours !== null && <span className="text-xs text-gray-500 flex-shrink-0">시간</span>}
              {t.maxDurationHours === null && <span className="text-xs text-gray-500">타임아웃 없음</span>}
            </div>
          </F>
          <F label="RSI 반전 청산 (적당선 익절)">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={t.rsiExitThreshold != null}
                onChange={e => st({ rsiExitThreshold: e.target.checked ? 40 : null })}
                className="w-4 h-4 accent-accent flex-shrink-0" />
              {t.rsiExitThreshold != null && (
                <input type="number" value={t.rsiExitThreshold}
                  onChange={e => st({ rsiExitThreshold: +e.target.value })}
                  className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
              )}
              {t.rsiExitThreshold != null && <span className="text-xs text-gray-500 flex-shrink-0">미만시</span>}
              {t.rsiExitThreshold == null && <span className="text-xs text-gray-500">비활성</span>}
            </div>
          </F>
          <F label="재진입 쿨다운">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={t.reEntryCooldownHours != null}
                onChange={e => st({ reEntryCooldownHours: e.target.checked ? 24 : null })}
                className="w-4 h-4 accent-accent flex-shrink-0" />
              {t.reEntryCooldownHours != null && (
                <input type="number" value={t.reEntryCooldownHours}
                  onChange={e => st({ reEntryCooldownHours: +e.target.value })}
                  className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
              )}
              {t.reEntryCooldownHours != null && <span className="text-xs text-gray-500 flex-shrink-0">시간</span>}
              {t.reEntryCooldownHours == null && <span className="text-xs text-gray-500">비활성</span>}
            </div>
          </F>
          <F label="그리드 RSI 과열 포기 (큰 손실 방지)">
            <div className="flex items-center gap-1">
              <input type="checkbox" checked={t.gridRsiSkipThreshold != null}
                onChange={e => st({ gridRsiSkipThreshold: e.target.checked ? 90 : null })}
                className="w-4 h-4 accent-accent flex-shrink-0" />
              {t.gridRsiSkipThreshold != null && (
                <input type="number" value={t.gridRsiSkipThreshold}
                  onChange={e => st({ gridRsiSkipThreshold: +e.target.value })}
                  className="w-full bg-surface border border-border rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-accent" />
              )}
              {t.gridRsiSkipThreshold != null && <span className="text-xs text-gray-500 flex-shrink-0">RSI 이상</span>}
              {t.gridRsiSkipThreshold == null && <span className="text-xs text-gray-500">비활성</span>}
            </div>
          </F>
        </div>
        <div className="text-xs text-gray-500 p-2 bg-card rounded-lg">
          {t.gridEnabled !== false
            ? `자동 손절(ISOLATED): 진입가 대비 ${Math.min(t.gridSpacing / t.leverage, 99 / t.leverage).toFixed(1)}% 상승시 (레버리지 반영)`
            : `손절: 진입가 대비 +${t.stopLossPct}% 상승시 청산`}
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

const REFRESH_SEC = 15;
const MANUAL_REFRESH_COOLDOWN_SEC = 5;

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

  const [expandedUserId, setExpandedUserId]                     = useState<string | null>(null);
  const [detailCache, setDetailCache]                           = useState<Map<string, UserDetail>>(new Map());
  const [detailLoading, setDetailLoading]                       = useState<string | null>(null);

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

  const [lastRefreshAt, setLastRefreshAt] = useState(Date.now());
  const [lastManualAt, setLastManualAt]   = useState(0);
  const [, setTick]                       = useState(0);

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

  // 통계/유저목록/스캐너 상태 + (펼쳐진 경우) 상세정보를 주기적으로 새로고침
  const refreshDashboard = useCallback(async () => {
    if (!authed) return;
    try {
      const [s, u, sc] = await Promise.all([getAdminStats(), getAdminUsers(), getAdminScanners()]);
      setStats(s); setUsers(u);
      setPaperIds(new Set(sc.paperUserIds));
      setLiveIds(new Set(sc.liveUserIds));
    } catch { /* 다음 주기에 재시도 */ }
    if (expandedUserId) {
      try {
        const detail = await getAdminUser(expandedUserId);
        setDetailCache(prev => new Map(prev).set(expandedUserId, detail));
      } catch { /* 다음 주기에 재시도 */ }
    }
    setLastRefreshAt(Date.now());
  }, [authed, expandedUserId]);

  useEffect(() => {
    if (!authed) return;
    const id = setInterval(refreshDashboard, REFRESH_SEC * 1000);
    return () => clearInterval(id);
  }, [authed, refreshDashboard]);

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsUntilRefresh = Math.max(0, REFRESH_SEC - Math.floor((Date.now() - lastRefreshAt) / 1000));
  const manualCooldownLeft  = Math.max(0, MANUAL_REFRESH_COOLDOWN_SEC - Math.floor((Date.now() - lastManualAt) / 1000));

  const handleManualRefresh = () => {
    if (manualCooldownLeft > 0) return;
    setLastManualAt(Date.now());
    refreshDashboard();
  };

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

  async function handleExpandUser(userId: string) {
    if (expandedUserId === userId) { setExpandedUserId(null); return; }
    setExpandedUserId(userId);
    if (!detailCache.has(userId)) {
      setDetailLoading(userId);
      try {
        const detail = await getAdminUser(userId);
        setDetailCache(prev => new Map(prev).set(userId, detail));
      } catch {}
      finally { setDetailLoading(null); }
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
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{secondsUntilRefresh}초 후 갱신</span>
            <button
              onClick={handleManualRefresh}
              disabled={manualCooldownLeft > 0}
              className="px-2 py-1 rounded border border-border text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {manualCooldownLeft > 0 ? `${manualCooldownLeft}초 후 가능` : '↻ 새로고침'}
            </button>
          </div>
          <button onClick={handleLogout}
            className="text-sm text-gray-400 hover:text-gray-200 border border-border rounded-lg px-3 py-1.5">
            로그아웃
          </button>
        </div>
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
                const isExpanded    = expandedUserId === u.id;
                const isLoadingDetail = detailLoading === u.id;
                return (
                  <>
                    <tr key={u.id} className={`border-b border-border/50 hover:bg-white/3 ${isExpanded ? 'bg-white/3' : ''}`}>
                      <td className="py-3 pr-4">
                        <button onClick={() => handleExpandUser(u.id)}
                          className="flex items-center gap-1.5 text-left hover:text-accent transition-colors">
                          <span className="text-xs text-gray-500">{isExpanded ? '▲' : '▼'}</span>
                          <span className="text-gray-200">{u.email}</span>
                        </button>
                      </td>
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
                    {isExpanded && (
                      <tr key={`${u.id}-detail`}>
                        <td colSpan={9} className="pb-1 pt-0">
                          {isLoadingDetail ? (
                            <div className="mx-2 mb-2 p-4 text-xs text-gray-500 text-center">로딩 중...</div>
                          ) : detailCache.get(u.id) ? (
                            <UserDetailPanel detail={detailCache.get(u.id)!} />
                          ) : null}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

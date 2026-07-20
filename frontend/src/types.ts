export interface Kline {
  openTime: number;
  open: number;
  high: number;
  close: number;
  low: number;
  volume: number;
  closeTime: number;
}

export interface StrategyConditions {
  rsi: { min: number; max: number; period: number; timeframe: string };
  priceChange24h: { min: number; max: number };
  priceChangeTimeframe: '1h' | '4h' | '24h';   // 가격 변화 기준 시간
  btcDominanceMax: number;   // 현재 비활성 (주석 처리)
  minListingDays?: number | null;  // null/0/미설정 = 비활성, 숫자 = 선물 상장일 기준 이 일수 미만이면 제외
  noRecentCrash?: { days: number; dropPct: number } | null;  // null/미설정 = 비활성. 최근 days일 내 일봉 기준 dropPct% 이상 급락한 적 있으면 제외
  // 하위 호환성
  priceAboveMa200?: boolean;
}

export interface TradeConfig {
  leverage: number;
  entryAmountUsdt: number;
  gridEnabled?: boolean;  // false = 그리드 없음 (단순 숏)
  gridLevels: number;
  gridSpacing: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxDurationHours: number | null;  // null = 타임아웃 없음
  rsiExitThreshold: number | null;  // null = 비활성, 숫자 = RSI 반전 청산 임계값
  reEntryCooldownHours?: number | null;  // null/0/미설정 = 비활성, 숫자 = 청산 후 해당 심볼 재진입 금지 시간 (하위 호환용 — win/loss 개별 설정이 없을 때 폴백)
  reEntryCooldownWinHours?: number | null;   // null/0/미설정 = reEntryCooldownHours로 폴백. 이전 청산이 수익이었을 때 재진입 금지 시간
  reEntryCooldownLossHours?: number | null;  // null/0/미설정 = reEntryCooldownHours로 폴백. 이전 청산이 손실이었을 때 재진입 금지 시간 (blockLossSymbols가 true면 무시됨)
  blockLossSymbols?: boolean;  // true면 해당 심볼에서 손실이 한 번이라도 발생한 적 있으면 이후 영구 재진입 금지 (쿨다운 무시)
  gridRsiSkipThreshold?: number | null;  // null/미설정 = 비활성, 숫자 = 그리드 체결 시점 RSI가 이 값 이상이면 그리드 포기 + 즉시 전체 청산
  liquidationSafetyPct?: number | null;  // null/미설정 = 기본 99 사용. 실제(또는 추정) 청산가까지 거리의 이 %지점에 안전 손절 설정, 이보다 먼 그리드 레벨은 등록하지 않음
}

export type Side = 'LONG' | 'SHORT';

export interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  side: Side;
  coins: string[];
  conditions: StrategyConditions;
  trade: TradeConfig;
  createdAt: number;
}

/**
 * 롱/숏 토글 시 조건 값을 실제로 미러링 — 라벨만 바꾸면 숏 기준 숫자(예: RSI 70 이상,
 * 가격상승률 20~100%)가 그대로 남아 롱에선 의미 없는 조건이 되므로, 100 대칭/부호 반전으로
 * 방향에 맞는 값으로 자동 변환한다. 정수 기준 완전한 역함수라 왕복 토글해도 값이 안 틀어짐.
 */
export function mirrorConditionsForSide(c: StrategyConditions, fromSide: Side, toSide: Side): StrategyConditions {
  if (fromSide === toSide) return c;
  const activeRsi = fromSide === 'SHORT' ? c.rsi.min : c.rsi.max;
  const mirroredRsi = 100 - activeRsi;
  return {
    ...c,
    rsi: toSide === 'SHORT'
      ? { ...c.rsi, min: mirroredRsi, max: 100 }
      : { ...c.rsi, min: 0, max: mirroredRsi },
    priceChange24h: { min: -c.priceChange24h.max, max: -c.priceChange24h.min }
  };
}

export function mirrorTradeForSide(t: TradeConfig, fromSide: Side, toSide: Side): TradeConfig {
  if (fromSide === toSide) return t;
  const mirror = (v: number | null | undefined) => v == null ? v : 100 - v;
  return {
    ...t,
    rsiExitThreshold: mirror(t.rsiExitThreshold) ?? null,
    gridRsiSkipThreshold: mirror(t.gridRsiSkipThreshold)
  };
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  rsi14: number;
  volumeRatio: number;
  aboveMa200: boolean;
  aboveBB: boolean;
  signalScore: number;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  avgEntryPrice: number;
  pnlPct: number;
  pnlUsdt: number;
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout';
  gridsFilled: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgProfitPct: number;
  avgLossPct: number;
  expectedValuePct: number;
  maxDrawdownPct: number;
  totalPnlPct: number;
  trades: BacktestTrade[];
  equityCurve: { time: number; equity: number }[];
}

export interface FuturesPosition {
  symbol: string;
  side: 'SHORT' | 'LONG';
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
  liquidationPrice: number;
  notional: number;
}

export interface AccountInfo {
  totalWalletBalance: number;
  availableBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
}

export interface ValidationResult {
  totalSignals: number;
  wins: number;
  winRate: number;
  expectedValuePct: number;
  avgProfitPct: number;
  avgLossPct: number;
  coinsAnalyzed: number;
  coinsWithSignal: number;
  interval: string;
  recentTotalSignals: number;      // 최근 62일 신호 수
  recentWins: number;              // 최근 62일 수익 수
  recentWinRate: number;
  recentAvgProfitPct: number;
  recentAvgLossPct: number;
  recentExpectedValuePct: number;
  perCoin: {
    symbol: string;
    signals: number;
    wins: number;
    winRate: number;
    recentSignals: number;  // 최근 62일 신호 수
    recentWins: number;     // 최근 62일 수익 수
  }[];
  message?: string;
}

export const DEFAULT_SIDE: Side = 'SHORT';

export const DEFAULT_CONDITIONS: StrategyConditions = {
  rsi: { min: 70, max: 100, period: 14, timeframe: '4h' },
  priceChange24h: { min: 20, max: 100 },
  priceChangeTimeframe: '24h',
  btcDominanceMax: 55,
  minListingDays: 30,
  noRecentCrash: { days: 7, dropPct: 50 }
};

export const DEFAULT_TRADE: TradeConfig = {
  leverage: 2,
  entryAmountUsdt: 100,
  gridEnabled: true,
  gridLevels: 3,
  gridSpacing: 72,
  takeProfitPct: 20,
  stopLossPct: 60,
  maxDurationHours: null,
  rsiExitThreshold: 40,
  reEntryCooldownHours: 24,
  reEntryCooldownWinHours: null,
  reEntryCooldownLossHours: null,
  blockLossSymbols: false,
  gridRsiSkipThreshold: 90,
  liquidationSafetyPct: 99
};

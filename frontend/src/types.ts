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
  volumeMultiplier: { min: number; max: number };
  priceAboveMa7: boolean;    // MA7 위 조건
  priceAboveMa20: boolean;   // MA20 위 조건
  priceAboveBB: boolean;     // 볼린저 상단 돌파
  btcDominanceMax: number;   // 현재 비활성 (주석 처리)
  minListingDays?: number | null;  // null/0/미설정 = 비활성, 숫자 = 선물 상장일 기준 이 일수 미만이면 제외
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
  reEntryCooldownHours?: number | null;  // null/0/미설정 = 비활성, 숫자 = 청산 후 해당 심볼 재진입 금지 시간
  gridRsiSkipThreshold?: number | null;  // null/미설정 = 비활성, 숫자 = 그리드 체결 시점 RSI가 이 값 이상이면 그리드 포기 + 즉시 전체 청산
}

export interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  coins: string[];
  conditions: StrategyConditions;
  trade: TradeConfig;
  createdAt: number;
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

export const DEFAULT_CONDITIONS: StrategyConditions = {
  rsi: { min: 70, max: 100, period: 14, timeframe: '4h' },
  priceChange24h: { min: 20, max: 100 },
  priceChangeTimeframe: '24h',
  volumeMultiplier: { min: 1, max: 50 },
  priceAboveMa7: true,
  priceAboveMa20: true,
  priceAboveBB: true,
  btcDominanceMax: 55,
  minListingDays: 30
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
  gridRsiSkipThreshold: 90
};

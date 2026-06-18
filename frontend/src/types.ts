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
  volumeMultiplier: { min: number; max: number };
  priceAboveMa200: boolean;
  btcDominanceMax: number;
}

export interface TradeConfig {
  leverage: number;
  entryAmountUsdt: number;
  gridLevels: number;
  gridSpacing: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxDurationHours: number;
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

// 전략 성과 검증 결과 (멀티코인 백테스트 집계)
export interface ValidationResult {
  totalSignals: number;      // 조건 충족 총 횟수
  wins: number;              // 수익 횟수
  winRate: number;           // 승률 (0~1)
  expectedValuePct: number;  // 기댓값 %
  avgProfitPct: number;      // 평균 수익 %
  avgLossPct: number;        // 평균 손실 %
  coinsAnalyzed: number;     // 분석한 코인 수
  coinsWithSignal: number;   // 신호 발생 코인 수
  interval: string;
  perCoin: {
    symbol: string;
    signals: number;
    wins: number;
    winRate: number;
  }[];
  message?: string;
}

export const DEFAULT_CONDITIONS: StrategyConditions = {
  rsi: { min: 70, max: 90, period: 14, timeframe: '1h' },
  priceChange24h: { min: 30, max: 200 },
  volumeMultiplier: { min: 3, max: 50 },
  priceAboveMa200: true,
  btcDominanceMax: 55
};

export const DEFAULT_TRADE: TradeConfig = {
  leverage: 3,
  entryAmountUsdt: 100,
  gridLevels: 5,
  gridSpacing: 10,
  takeProfitPct: 20,
  stopLossPct: 60,
  maxDurationHours: 72
};

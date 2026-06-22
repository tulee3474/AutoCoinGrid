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
  // 하위 호환성 유지
  priceAboveMa200?: boolean;
}

export interface TradeConfig {
  leverage: number;
  entryAmountUsdt: number;
  gridLevels: number;
  gridSpacing: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxDurationHours: number | null;  // null = 타임아웃 없음
  rsiExitThreshold: number | null;  // null = 비활성, 숫자 = RSI가 이 값 미만이면 조기 청산
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

export interface Position {
  id: string;
  symbol: string;
  side: 'SHORT';
  leverage: number;
  entryPrice: number;
  markPrice: number;
  quantity: number;
  notionalUsdt: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  gridOrders: GridOrder[];
  openedAt: number;
  strategyId: string;
}

export interface GridOrder {
  level: number;
  price: number;
  quantity: number;
  status: 'pending' | 'open' | 'filled' | 'cancelled';
  orderId?: string;
}

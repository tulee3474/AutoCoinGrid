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
  priceChange24h: { min: number; max: number };     // % 범위 (예: 20~100 = 24시간 20%~100% 상승)
  volumeMultiplier: { min: number; max: number };   // 평균 대비 볼륨 배수
  priceAboveMa200: boolean;                          // MA200 위에 있어야 진입 (펌핑 코인 조건)
  priceAboveBB: boolean;                             // 볼린저 상단 돌파 코인만 (급등 확인)
  btcDominanceMax: number;                           // BTC 도미넌스 상한 (알트코인 장세 확인)
}

export interface TradeConfig {
  leverage: number;         // 2~5배
  entryAmountUsdt: number; // 진입 금액 (USDT)
  gridLevels: number;       // 그리드 주문 개수 (5~10)
  gridSpacing: number;      // 그리드 간격 (%, 예: 10)
  takeProfitPct: number;    // 익절 % (예: 15 = 진입가 대비 15% 하락시 익절)
  stopLossPct: number;      // 손절 % (예: 20 = 진입가 대비 20% 상승시 손절)
  maxDurationHours: number; // 최대 보유 시간
}

export interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  coins: string[];   // [] = 스캐너가 찾은 전체 코인
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
  signalScore: number; // 0~100, 조건 충족 점수
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  avgEntryPrice: number; // 그리드 포함 평균 진입가
  pnlPct: number;        // 레버리지 적용 손익 %
  pnlUsdt: number;
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout';
  gridsFilled: number;   // 추가 진입된 그리드 개수
}

export interface BacktestResult {
  symbol: string;
  timeframe: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;          // 0~1
  avgProfitPct: number;
  avgLossPct: number;
  expectedValuePct: number; // 기댓값 (베이지안 스타일)
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

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
  // 하위 호환성 유지
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
  rsiExitThreshold: number | null;  // null = 비활성, 숫자 = RSI가 이 값 미만이면 조기 청산
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

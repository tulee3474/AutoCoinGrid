import axios from 'axios';
import { StrategyConditions, TradeConfig, StrategyConfig } from '../types';

const api = axios.create({ baseURL: '/api', timeout: 30000 });

// JWT 자동 첨부
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 401 → 로그인 페이지로
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/admin')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

// ── 인증 ──────────────────────────────────────────────────────

export const register = (email: string, password: string) =>
  api.post('/auth/register', { email, password }).then(r => r.data as { token: string; user: AuthUser });

export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then(r => r.data as { token: string; user: AuthUser });

export const getMe = () =>
  api.get('/auth/me').then(r => r.data as AuthUser);

export const saveApiKeys = (apiKey: string, apiSecret: string) =>
  api.put('/auth/api-keys', { apiKey, apiSecret }).then(r => r.data);

export const deleteApiKeys = () =>
  api.delete('/auth/api-keys').then(r => r.data);

// ── 관리자 ─────────────────────────────────────────────────────

const adminApi = axios.create({ baseURL: '/api', timeout: 30000 });
adminApi.interceptors.request.use(config => {
  const token = localStorage.getItem('adminToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const adminLogin = (password: string) =>
  adminApi.post('/admin/login', { password }).then(r => r.data as { token: string });

export const getAdminStats = () =>
  adminApi.get('/admin/stats').then(r => r.data);

export const getAdminUsers = () =>
  adminApi.get('/admin/users').then(r => r.data as AdminUser[]);

export const getAdminUser = (userId: string) =>
  adminApi.get(`/admin/users/${userId}`).then(r => r.data);

export const deleteAdminUser = (userId: string) =>
  adminApi.delete(`/admin/users/${userId}`).then(r => r.data);

export const getAdminScanners = () =>
  adminApi.get('/admin/scanners').then(r => r.data as { paperUserIds: string[]; liveUserIds: string[] });

export const adminStartPaperScanner = (userId: string) =>
  adminApi.post(`/admin/scanners/paper/${userId}/start`).then(r => r.data);
export const adminStopPaperScanner = (userId: string) =>
  adminApi.post(`/admin/scanners/paper/${userId}/stop`).then(r => r.data);

export const adminStartLiveScanner = (userId: string) =>
  adminApi.post(`/admin/scanners/live/${userId}/start`).then(r => r.data);
export const adminStopLiveScanner = (userId: string) =>
  adminApi.post(`/admin/scanners/live/${userId}/stop`).then(r => r.data);

// ── 타입 ──────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  hasApiKeys: boolean;
}

export interface AdminUser {
  id: string;
  email: string;
  createdAt: string;
  hasApiKeys: boolean;
  strategies: number;
  livePositions: number;
  liveTrades: number;
  paperBalance: number | null;
}

// ── 마켓 ──────────────────────────────────────────────────────

export const getTopTickers = () =>
  api.get('/market/tickers').then(r => r.data);

export const getKlines = (symbol: string, interval = '1h', limit = 200) =>
  api.get(`/market/klines/${symbol}`, { params: { interval, limit } }).then(r => r.data);

export const getIndicators = (symbol: string, interval = '1h') =>
  api.get(`/market/indicators/${symbol}`, { params: { interval } }).then(r => r.data);

export const scanMarket = (conditions: StrategyConditions, btcDominance: number) =>
  api.post('/market/scan', { conditions, btcDominance }).then(r => r.data);

export const getBtcDominance = () =>
  api.get('/market/dominance').then(r => r.data.dominance as number);

// ── 전략 ──────────────────────────────────────────────────────

export const getStrategies = () =>
  api.get('/strategy').then(r => r.data as StrategyConfig[]);

export const createStrategy = (s: Omit<StrategyConfig, 'id' | 'createdAt'>) =>
  api.post('/strategy', s).then(r => r.data as StrategyConfig);

export const updateStrategy = (id: string, s: Partial<StrategyConfig>) =>
  api.put(`/strategy/${id}`, s).then(r => r.data as StrategyConfig);

export const deleteStrategy = (id: string) =>
  api.delete(`/strategy/${id}`).then(r => r.data);

export const toggleStrategy = (id: string) =>
  api.post(`/strategy/${id}/toggle`).then(r => r.data as StrategyConfig);

// ── 백테스트 ─────────────────────────────────────────────────

export const runBacktest = (params: {
  symbol: string;
  interval: string;
  limit: number;
  conditions: StrategyConditions;
  trade: TradeConfig;
  btcDominance?: number;
}) => api.post('/backtest/run', params).then(r => r.data);

// 전략 성과 자동 검증 (상위 알트코인 멀티 백테스트 → 집계)
export const validateStrategy = (params: {
  conditions: StrategyConditions;
  trade: TradeConfig;
}) => api.post('/backtest/validate', params).then(r => r.data);

export const runMultiBacktest = (params: {
  symbols: string[];
  interval: string;
  limit: number;
  conditions: StrategyConditions;
  trade: TradeConfig;
}) => api.post('/backtest/multi', params).then(r => r.data);

// ── 가상 지갑 (Paper Trading) ─────────────────────────────────

export const getPaperWallet = () =>
  api.get('/paper/wallet').then(r => r.data);

export const getPaperPositions = () =>
  api.get('/paper/positions').then(r => r.data);

export const getPaperLogs = (limit = 50) =>
  api.get('/paper/logs', { params: { limit } }).then(r => r.data);

export const resetPaperWallet = () =>
  api.post('/paper/reset').then(r => r.data);

export const closePaperPosition = (id: string) =>
  api.delete(`/paper/positions/${id}`).then(r => r.data);

export const getPaperScannerStatus = () =>
  api.get('/paper/scanner/status').then(r => r.data);

export const startPaperScanner = () =>
  api.post('/paper/scanner/start').then(r => r.data);

export const stopPaperScanner = () =>
  api.post('/paper/scanner/stop').then(r => r.data);

// ── 역사적 BTC 도미넌스 데이터 ───────────────────────────────

export const getBtcDomDataInfo = () =>
  api.get('/data/btc-dominance').then(r => r.data);

export const getBtcDomRawCSV = () =>
  api.get('/data/btc-dominance/raw').then(r => r.data.content as string);

// 관리자 전용 (adminApi 사용)
export const uploadBtcDomCSV = (csv: string) =>
  adminApi.post('/data/btc-dominance', { csv }).then(r => r.data);

export const deleteBtcDomData = () =>
  adminApi.delete('/data/btc-dominance').then(r => r.data);

export const fetchBtcDomFromCoinGecko = (days = 365) =>
  adminApi.post('/data/btc-dominance/fetch', null, { params: { days }, timeout: 60_000 }).then(r => r.data);

// ── 실제 거래 (Live Trading) ──────────────────────────────────

export const getLiveStatus = () =>
  api.get('/live/status').then(r => r.data as { running: boolean; stopping: boolean; openCount: number; totalTrades: number });

export const startLiveScanner = () =>
  api.post('/live/start').then(r => r.data);

export const stopLiveScanner = () =>
  api.post('/live/stop').then(r => r.data);

export const forceStopLiveScanner = () =>
  api.post('/live/force-stop').then(r => r.data);

export const getLivePositions = () =>
  api.get('/live/positions').then(r => r.data as LivePosition[]);

export const getLiveLogs = (limit = 50) =>
  api.get('/live/logs', { params: { limit } }).then(r => r.data as LiveTradeLog[]);

export const getLiveScanLog = () =>
  api.get('/live/scan-log').then(r => r.data as ScanLogEntry[]);

export const getLiveStats = () =>
  api.get('/live/stats').then(r => r.data as { totalTrades: number; totalPnlUsdt: number; winRate: number });

export const getLiveStrategyStats = () =>
  api.get('/live/strategy-stats').then(r => r.data as Record<string, { winRate: number; trades: number }>);

export const getPaperStrategyStats = () =>
  api.get('/paper/strategy-stats').then(r => r.data as Record<string, { winRate: number; trades: number }>);

export const closeLivePosition = (symbol: string) =>
  api.delete(`/live/position/${symbol}`).then(r => r.data);

export interface LivePosition {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  currentPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryAmountUsdt: number;
  leverage: number;
  pnlPct: number;
  pnlUsdt: number;
  openedAt: string;
  expiresAt: string;
  strategyName: string;
}

export interface LiveTradeLog {
  id: string;
  symbol: string;
  side: string;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  pnlUsdt: number;
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual';
  entryAmountUsdt: number;
  leverage: number;
  strategyName: string;
}

export interface ScanLogEntry {
  time: number;
  message: string;
  type: 'info' | 'signal' | 'close' | 'error';
}

// ── 전략 프리셋 ───────────────────────────────────────────────

export const getPresets = () =>
  api.get('/presets').then(r => r.data as { default: AdminPreset | null; recommended: AdminPreset[] });

export const adminCreatePreset = (data: Omit<AdminPreset, 'id' | 'createdAt' | 'updatedAt'>) =>
  adminApi.post('/presets', data).then(r => r.data as AdminPreset);

export const adminUpdatePreset = (id: string, data: Partial<Omit<AdminPreset, 'id'>>) =>
  adminApi.put(`/presets/${id}`, data).then(r => r.data as AdminPreset);

export const adminDeletePreset = (id: string) =>
  adminApi.delete(`/presets/${id}`).then(r => r.data);

export interface AdminPreset {
  id: string;
  type: 'default' | 'recommended';
  name: string;
  conditions: import('../types').StrategyConditions;
  trade: import('../types').TradeConfig;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

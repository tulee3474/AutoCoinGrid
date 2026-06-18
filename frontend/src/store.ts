import { create } from 'zustand';
import {
  StrategyConfig, MarketSnapshot, BacktestResult,
  ValidationResult,
  DEFAULT_CONDITIONS, DEFAULT_TRADE
} from './types';

interface TopTicker {
  symbol: string;
  change24h: number;
  volume24h: number;
}

interface AppState {
  // 전략
  strategies: StrategyConfig[];
  activeStrategy: StrategyConfig | null;
  setStrategies: (s: StrategyConfig[]) => void;
  setActiveStrategy: (s: StrategyConfig | null) => void;

  // 스캐너
  scanResults: MarketSnapshot[];
  scanning: boolean;
  setScanResults: (r: MarketSnapshot[]) => void;
  setScanning: (v: boolean) => void;

  // 백테스트
  backtestResult: BacktestResult | null;
  backtesting: boolean;
  setBacktestResult: (r: BacktestResult | null) => void;
  setBacktesting: (v: boolean) => void;

  // BTC 도미넌스
  btcDominance: number;
  setBtcDominance: (v: number) => void;

  // 전략 성과 검증
  validationResult: ValidationResult | null;
  validating: boolean;
  setValidationResult: (r: ValidationResult | null) => void;
  setValidating: (v: boolean) => void;

  // 24h 급등 코인 목록 (Dashboard → Backtest 공유)
  topTickers: TopTicker[];
  setTopTickers: (t: TopTicker[]) => void;

  // 임시 전략 편집 상태
  draftConditions: typeof DEFAULT_CONDITIONS;
  draftTrade: typeof DEFAULT_TRADE;
  setDraftConditions: (c: Partial<typeof DEFAULT_CONDITIONS>) => void;
  setDraftTrade: (t: Partial<typeof DEFAULT_TRADE>) => void;
  resetDraft: () => void;
}

export const useStore = create<AppState>((set) => ({
  strategies: [],
  activeStrategy: null,
  setStrategies: (strategies) => set({ strategies }),
  setActiveStrategy: (activeStrategy) => set({ activeStrategy }),

  scanResults: [],
  scanning: false,
  setScanResults: (scanResults) => set({ scanResults }),
  setScanning: (scanning) => set({ scanning }),

  backtestResult: null,
  backtesting: false,
  setBacktestResult: (backtestResult) => set({ backtestResult }),
  setBacktesting: (backtesting) => set({ backtesting }),

  btcDominance: 50,
  setBtcDominance: (btcDominance) => set({ btcDominance }),

  validationResult: null,
  validating: false,
  setValidationResult: (validationResult) => set({ validationResult }),
  setValidating: (validating) => set({ validating }),

  topTickers: [],
  setTopTickers: (topTickers) => set({ topTickers }),

  draftConditions: { ...DEFAULT_CONDITIONS },
  draftTrade: { ...DEFAULT_TRADE },
  setDraftConditions: (c) =>
    set((state) => ({ draftConditions: { ...state.draftConditions, ...c } })),
  setDraftTrade: (t) =>
    set((state) => ({ draftTrade: { ...state.draftTrade, ...t } })),
  resetDraft: () => set({ draftConditions: { ...DEFAULT_CONDITIONS }, draftTrade: { ...DEFAULT_TRADE } })
}));

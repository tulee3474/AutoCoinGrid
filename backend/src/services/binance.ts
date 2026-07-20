import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { Kline } from '../types';
import { getAllMarkPrices, isMarkPriceStreamHealthy } from './binanceMarketStream';
import { calcIsolatedLiquidationPrice } from './gridUtils';

export interface LeverageBracket {
  bracket: number;
  initialLeverage: number;
  notionalCap: number;
  notionalFloor: number;
  maintMarginRatio: number;
  cum: number;
}

const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const TESTNET_FUTURES = 'https://testnet.binancefuture.com';

// "Way too many requests; IP(x.x.x.x) banned until 1782784293771. ..." 메시지에서 차단 해제 시각 추출
const BAN_UNTIL_RE = /banned until (\d+)/;

export class BinanceService {
  private apiKey: string;
  private apiSecret: string;
  private futuresBase: string;
  private spotClient: AxiosInstance;
  private futuresClient: AxiosInstance;
  private futuresSymbolsCache: Set<string> | null = null;
  private futuresSymbolsCachedAt = 0;
  private futuresOnboardDatesCache: Map<string, number> | null = null;
  private futuresOnboardDatesCachedAt = 0;
  private klinesCache = new Map<string, { data: Kline[]; ts: number }>();
  // 기존 50초(스캔 사이클 60초보다 짧음)는 사이클마다 항상 캐시가 만료돼 매번 재호출되는
  // 결과를 낳았음 — 후보 코인이 수백 개인 전략이 여러 개면 이 재호출만으로 weight가 크게 소모됨.
  // 60초보다 살짝 길게 잡아 최소한 인접 사이클끼리는 캐시를 재사용하도록 함
  private static readonly KLINES_CACHE_TTL = 90_000;

  // 1d/4h처럼 느리게 바뀌는 캔들은 매 스캔 사이클(60s)마다 새로 받을 필요가 없음 —
  // 짧은 캐시로는 다음 사이클 전에 항상 만료돼 매번 재호출되므로, 긴 타임프레임은 캐시를 더 길게 유지
  private static klinesCacheTtlFor(interval: string): number {
    if (interval === '1d') return 600_000;
    if (interval === '4h') return 300_000;
    return BinanceService.KLINES_CACHE_TTL;
  }
  private futuresTickersCache: { data: any[]; ts: number } | null = null;
  private static readonly TICKERS_CACHE_TTL = 50_000;
  private futuresKlinesInflight = new Map<string, Promise<Kline[]>>();
  private futuresTickersInflight: Promise<any[]> | null = null;
  private futuresPremiumIndexCache: { data: any[]; ts: number } | null = null;
  // 프론트엔드 시세 갱신 주기(10초)보다 짧게 — 그보다 길면 "N초 후 갱신" UI가 실제로는 갱신 안 된 값을 보여주게 됨
  private static readonly PREMIUM_INDEX_CACHE_TTL = 8_000;
  private futuresPremiumIndexInflight: Promise<any[]> | null = null;

  // IP 차단은 인스턴스가 아니라 실제 서버 IP 단위로 걸리므로 static으로 전체 인스턴스(유저별 거래용 + 스캐너용 싱글톤) 공유
  private static spotBannedUntil = 0;
  private static futuresBannedUntil = 0;
  // 로그에서 완전 차단(418)과 일시 제한(429)을 구분해 보여주기 위한 사유 기록
  private static spotBanReason: '418' | '429' | null = null;
  private static futuresBanReason: '418' | '429' | null = null;

  constructor(apiKey?: string, apiSecret?: string) {
    this.apiKey    = apiKey    ?? '';
    this.apiSecret = apiSecret ?? '';
    this.futuresBase = process.env.USE_TESTNET === 'true' ? TESTNET_FUTURES : FUTURES_BASE;

    this.spotClient = axios.create({ baseURL: SPOT_BASE, timeout: 10000 });
    this.futuresClient = axios.create({
      baseURL: this.futuresBase,
      timeout: 10000,
      headers: { 'X-MBX-APIKEY': this.apiKey }
    });

    this.installBanGuard(this.spotClient, 'spot');
    this.installBanGuard(this.futuresClient, 'futures');
  }

  // 418 차단 응답을 감지해 해제 시각까지 동일 IP의 모든 후속 요청을 네트워크 호출 없이 즉시 실패시킴
  // (차단 중 계속 요청을 보내면 차단이 더 길어질 위험 + 불필요한 로그 스팸 방지)
  private installBanGuard(client: AxiosInstance, kind: 'spot' | 'futures') {
    client.interceptors.request.use(config => {
      const bannedUntil = kind === 'spot' ? BinanceService.spotBannedUntil : BinanceService.futuresBannedUntil;
      if (Date.now() < bannedUntil) {
        const reason = (kind === 'spot' ? BinanceService.spotBanReason : BinanceService.futuresBanReason);
        const label  = reason === '429' ? '일시 제한' : 'IP 차단';
        return Promise.reject(new Error(
          `Binance ${kind === 'spot' ? 'Spot' : 'Futures'} ${label} 중 — 해제 예정: ${new Date(bannedUntil).toLocaleTimeString('ko-KR', { hour12: false, timeZone: 'Asia/Seoul' })}`
        ));
      }
      return config;
    });
    client.interceptors.response.use(
      res => res,
      err => {
        const status = err.response?.status;
        const msg = err.response?.data?.msg as string | undefined;
        const match = msg && BAN_UNTIL_RE.exec(msg);

        if (match) {
          // 418: 완전 차단 — 응답에 명시된 해제 시각을 그대로 사용
          const until = parseInt(match[1], 10);
          if (kind === 'spot') { BinanceService.spotBannedUntil = until; BinanceService.spotBanReason = '418'; }
          else { BinanceService.futuresBannedUntil = until; BinanceService.futuresBanReason = '418'; }
        } else if (status === 429) {
          // 429: 완전 차단 전 단계 경고 — 무시하고 계속 요청하면 418 완전 차단으로 악화됨.
          // Retry-After 헤더(초) 만큼, 없으면 기본 10초 동안 이 IP의 후속 요청을 스스로 멈춤
          const retryAfterSec = parseInt(err.response?.headers?.['retry-after'] ?? '', 10);
          const throttleMs = (Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 10) * 1000;
          const until = Date.now() + throttleMs;
          if (kind === 'spot') {
            if (until > BinanceService.spotBannedUntil) { BinanceService.spotBannedUntil = until; BinanceService.spotBanReason = '429'; }
          } else {
            if (until > BinanceService.futuresBannedUntil) { BinanceService.futuresBannedUntil = until; BinanceService.futuresBanReason = '429'; }
          }
        }
        return Promise.reject(err);
      }
    );
  }

  private sign(params: Record<string, string | number>): string {
    const query = new URLSearchParams(params as Record<string, string>).toString();
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private signedParams(params: Record<string, string | number> = {}) {
    const withTimestamp = { ...params, timestamp: Date.now() };
    const signature = this.sign(withTimestamp);
    return { ...withTimestamp, signature };
  }

  // ── 퍼블릭 API ──────────────────────────────────────────────

  async getKlines(symbol: string, interval: string, limit = 500, startTime?: number): Promise<Kline[]> {
    // startTime 지정 시(과거 구간 조회)는 캐시 대상 아님 — 스캐너의 "최근 N개" 조회만 캐시
    const cacheKey = !startTime ? `${symbol}|${interval}|${limit}` : null;
    if (cacheKey) {
      const cached = this.klinesCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < BinanceService.KLINES_CACHE_TTL) return cached.data;
    }

    const params: Record<string, any> = { symbol, interval, limit };
    if (startTime) params.startTime = startTime;
    let res;
    try {
      res = await this.spotClient.get('/api/v3/klines', { params });
    } catch (e: any) {
      // 429: Rate limit → 5초 대기 후 1회 재시도
      if (e.response?.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
        res = await this.spotClient.get('/api/v3/klines', { params });
      } else {
        throw e;
      }
    }
    const data: Kline[] = res.data.map((k: any[]) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: k[6]
    }));
    if (cacheKey) this.klinesCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  async getKlinesSince(symbol: string, interval: string, startTime: number): Promise<Kline[]> {
    const { data } = await this.spotClient.get('/api/v3/klines', {
      params: { symbol, interval, startTime, limit: 1500 }
    });
    return data.map((k: any[]) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: k[6]
    }));
  }

  // startTime부터 현재까지 모든 캔들을 1500개씩 페이지네이션으로 수집
  async getKlinesPaged(symbol: string, interval: string, startTime: number): Promise<Kline[]> {
    const all: Kline[] = [];
    let from = startTime;
    while (true) {
      const { data } = await this.spotClient.get('/api/v3/klines', {
        params: { symbol, interval, startTime: from, limit: 1500 }
      });
      const batch: Kline[] = data.map((k: any[]) => ({
        openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
        close: +k[4], volume: +k[5], closeTime: k[6]
      }));
      all.push(...batch);
      if (batch.length < 1500) break;
      from = batch[batch.length - 1].closeTime + 1;
    }
    return all;
  }

  async getFuturesKlines(symbol: string, interval: string, limit = 500): Promise<Kline[]> {
    const cacheKey = `${symbol}|${interval}|${limit}`;
    const cached = this.klinesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < BinanceService.klinesCacheTtlFor(interval)) return cached.data;

    // 동시에 여러 전략/유저가 같은 심볼을 요청해도 실제 HTTP 호출은 1회만 — 진행 중인 요청을 공유
    const inflight = this.futuresKlinesInflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
      let res;
      try {
        res = await this.futuresClient.get('/fapi/v1/klines', { params: { symbol, interval, limit } });
      } catch (e: any) {
        if (e.response?.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
          res = await this.futuresClient.get('/fapi/v1/klines', { params: { symbol, interval, limit } });
        } else {
          throw e;
        }
      }
      const data: Kline[] = res.data.map((k: any[]) => ({
        openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
        close: +k[4], volume: +k[5], closeTime: k[6]
      }));
      this.klinesCache.set(cacheKey, { data, ts: Date.now() });
      return data;
    })();

    this.futuresKlinesInflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.futuresKlinesInflight.delete(cacheKey);
    }
  }

  // 선물 전용 상장 코인은 스팟에 존재하지 않아 getKlinesSince(스팟)로는 캔들을 못 가져옴 — 포지션 모니터링(그리드/SL/TP 소급 감지)은 반드시 선물 캔들 사용
  // startTime(포지션 오픈 시각)이 고정값이라 캐시 키로 안전 — 가상거래 스캔 사이클(60초)마다
  // 유저별로 반복 호출되며 매번 weight 10(limit>1000)짜리 요청을 새로 보내던 걸 캐시로 흡수
  async getFuturesKlinesSince(symbol: string, interval: string, startTime: number): Promise<Kline[]> {
    const cacheKey = `${symbol}|${interval}|since:${startTime}`;
    const cached = this.klinesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < BinanceService.KLINES_CACHE_TTL) return cached.data;

    // 필요한 캔들 수만 요청 (경과 시간 기반, 최대 1500) — 매번 최대치로 요청하던 weight 낭비 제거
    const minsPerCandle: Record<string, number> = {
      '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440
    };
    const elapsedMs = Math.max(0, Date.now() - startTime);
    const neededCandles = Math.ceil(elapsedMs / ((minsPerCandle[interval] ?? 60) * 60_000)) + 2;
    const limit = Math.min(1500, Math.max(2, neededCandles));

    const { data } = await this.futuresClient.get('/fapi/v1/klines', {
      params: { symbol, interval, startTime, limit }
    });
    const result: Kline[] = data.map((k: any[]) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: k[6]
    }));
    this.klinesCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  async get24hrTickers(): Promise<any[]> {
    const { data } = await this.spotClient.get('/api/v3/ticker/24hr');
    return data;
  }

  async getFutures24hrTickers(): Promise<any[]> {
    if (this.futuresTickersCache && Date.now() - this.futuresTickersCache.ts < BinanceService.TICKERS_CACHE_TTL) {
      return this.futuresTickersCache.data;
    }
    // 같은 사이클 내 여러 전략/유저의 동시 요청을 1회 호출로 합침
    if (this.futuresTickersInflight) return this.futuresTickersInflight;

    this.futuresTickersInflight = (async () => {
      const { data } = await this.futuresClient.get('/fapi/v1/ticker/24hr');
      this.futuresTickersCache = { data, ts: Date.now() };
      return data;
    })();

    try {
      return await this.futuresTickersInflight;
    } finally {
      this.futuresTickersInflight = null;
    }
  }

  // 심볼 정밀도/상장일 등 메타데이터라 자주 안 바뀜 — 매 사이클(15초)마다 재조회하던 걸 1시간 캐시로 흡수
  private futuresExchangeInfoCache: { data: any; ts: number } | null = null;
  private static readonly EXCHANGE_INFO_CACHE_TTL = 3_600_000;

  async getFuturesExchangeInfo(): Promise<any> {
    if (this.futuresExchangeInfoCache && Date.now() - this.futuresExchangeInfoCache.ts < BinanceService.EXCHANGE_INFO_CACHE_TTL) {
      return this.futuresExchangeInfoCache.data;
    }
    const { data } = await this.futuresClient.get('/fapi/v1/exchangeInfo');
    this.futuresExchangeInfoCache = { data, ts: Date.now() };
    return data;
  }

  async getFuturesSymbols(): Promise<Set<string>> {
    if (this.futuresSymbolsCache && Date.now() - this.futuresSymbolsCachedAt < 3_600_000) {
      return this.futuresSymbolsCache;
    }
    const info = await this.getFuturesExchangeInfo();
    this.futuresSymbolsCache = new Set(
      (info.symbols as any[])
        .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
        .map((s: any) => s.symbol)
    );
    this.futuresSymbolsCachedAt = Date.now();
    return this.futuresSymbolsCache;
  }

  // 심볼 → 선물 상장일(onboardDate, ms) — 상장 N일 미만 코인 제외 필터용
  async getFuturesOnboardDates(): Promise<Map<string, number>> {
    if (this.futuresOnboardDatesCache && Date.now() - this.futuresOnboardDatesCachedAt < 3_600_000) {
      return this.futuresOnboardDatesCache;
    }
    const info = await this.getFuturesExchangeInfo();
    this.futuresOnboardDatesCache = new Map(
      (info.symbols as any[]).map((s: any) => [s.symbol, s.onboardDate as number])
    );
    this.futuresOnboardDatesCachedAt = Date.now();
    return this.futuresOnboardDatesCache;
  }

  async getFuturesPremiumIndex(): Promise<any[]> {
    // 마크 가격 웹소켓 스트림이 살아있으면 REST 폴링 없이 그 캐시를 REST와 동일한 모양으로 반환.
    // 스트림이 끊기면 아래 기존 REST(+캐시) 경로로 자동 폴백.
    if (isMarkPriceStreamHealthy()) {
      return Array.from(getAllMarkPrices(), ([symbol, markPrice]) => ({ symbol, markPrice: markPrice.toString() }));
    }

    if (this.futuresPremiumIndexCache && Date.now() - this.futuresPremiumIndexCache.ts < BinanceService.PREMIUM_INDEX_CACHE_TTL) {
      return this.futuresPremiumIndexCache.data;
    }
    if (this.futuresPremiumIndexInflight) return this.futuresPremiumIndexInflight;

    this.futuresPremiumIndexInflight = (async () => {
      const { data } = await this.futuresClient.get('/fapi/v1/premiumIndex');
      this.futuresPremiumIndexCache = { data, ts: Date.now() };
      return data;
    })();

    try {
      return await this.futuresPremiumIndexInflight;
    } finally {
      this.futuresPremiumIndexInflight = null;
    }
  }

  // ── 인증 필요 API ────────────────────────────────────────────
  // 실거래 sync 루프(15초)에서 syncClosed/fillLiveGrids/closeOnRsiReversal 등 여러 함수가
  // 같은 사이클 내에서 각자 조회하면서 IP weight를 불필요하게 반복 소모 — 짧은 TTL로 흡수
  private static readonly ACCOUNT_CACHE_TTL = 5_000;
  private accountInfoCache: { data: any; ts: number } | null = null;
  private positionsCache: { data: any[]; ts: number } | null = null;

  async getAccountInfo(): Promise<any> {
    if (this.accountInfoCache && Date.now() - this.accountInfoCache.ts < BinanceService.ACCOUNT_CACHE_TTL) {
      return this.accountInfoCache.data;
    }
    const { data } = await this.futuresClient.get('/fapi/v2/account', {
      params: this.signedParams()
    });
    this.accountInfoCache = { data, ts: Date.now() };
    return data;
  }

  async getPositions(): Promise<any[]> {
    if (this.positionsCache && Date.now() - this.positionsCache.ts < BinanceService.ACCOUNT_CACHE_TTL) {
      return this.positionsCache.data;
    }
    const { data } = await this.futuresClient.get('/fapi/v2/positionRisk', {
      params: this.signedParams()
    });
    const filtered = (data as any[]).filter(p => parseFloat(p.positionAmt) !== 0);
    this.positionsCache = { data: filtered, ts: Date.now() };
    return filtered;
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params = symbol ? this.signedParams({ symbol }) : this.signedParams();
    const { data } = await this.futuresClient.get('/fapi/v1/openOrders', { params });
    return data;
  }

  async setLeverage(symbol: string, leverage: number): Promise<any> {
    const { data } = await this.futuresClient.post('/fapi/v1/leverage', null, {
      params: this.signedParams({ symbol, leverage })
    });
    return data;
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<any> {
    try {
      const { data } = await this.futuresClient.post('/fapi/v1/marginType', null, {
        params: this.signedParams({ symbol, marginType })
      });
      return data;
    } catch {
      // 이미 설정된 경우 에러 무시
    }
  }

  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    price?: string;
    stopPrice?: string;
    reduceOnly?: boolean;
    closePosition?: boolean;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }): Promise<any> {
    const body: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type,
    };
    if (params.quantity) body.quantity = params.quantity;
    if (params.price) { body.price = params.price; body.timeInForce = 'GTC'; }
    if (params.stopPrice) body.stopPrice = params.stopPrice;
    if (params.reduceOnly) body.reduceOnly = 'true';
    if (params.closePosition) body.closePosition = 'true';
    if (params.positionSide) body.positionSide = params.positionSide;

    const { data } = await this.futuresClient.post('/fapi/v1/order', null, {
      params: this.signedParams(body)
    });
    return data;
  }

  // 2025-12-09부로 STOP_MARKET/TAKE_PROFIT_MARKET 등 조건부 주문은 /fapi/v1/order에서 막히고
  // 전용 Algo Order API(/fapi/v1/algoOrder)로 이전됨 (-4120 STOP_ORDER_SWITCH_ALGO)
  async placeAlgoOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    triggerPrice: string;
    quantity?: string;
    reduceOnly?: boolean;
    closePosition?: boolean;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }): Promise<any> {
    const body: Record<string, string> = {
      algoType: 'CONDITIONAL',
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      triggerPrice: params.triggerPrice,
    };
    if (params.quantity) body.quantity = params.quantity;
    if (params.reduceOnly) body.reduceOnly = 'true';
    if (params.closePosition) body.closePosition = 'true';
    if (params.positionSide) body.positionSide = params.positionSide;

    const { data } = await this.futuresClient.post('/fapi/v1/algoOrder', null, {
      params: this.signedParams(body)
    });
    return data; // { algoId, ... }
  }

  async getAlgoOrder(algoId: number): Promise<any> {
    const { data } = await this.futuresClient.get('/fapi/v1/algoOrder', {
      params: this.signedParams({ algoId })
    });
    return data;
  }

  async cancelAlgoOrder(algoId: number): Promise<any> {
    const { data } = await this.futuresClient.delete('/fapi/v1/algoOrder', {
      params: this.signedParams({ algoId })
    });
    return data;
  }

  async cancelAllAlgoOrders(symbol: string): Promise<any> {
    const { data } = await this.futuresClient.delete('/fapi/v1/algoOpenOrders', {
      params: this.signedParams({ symbol })
    });
    return data;
  }

  async cancelOrder(symbol: string, orderId: number): Promise<any> {
    const { data } = await this.futuresClient.delete('/fapi/v1/order', {
      params: this.signedParams({ symbol, orderId })
    });
    return data;
  }

  async cancelAllOrders(symbol: string): Promise<any> {
    const { data } = await this.futuresClient.delete('/fapi/v1/allOpenOrders', {
      params: this.signedParams({ symbol })
    });
    return data;
  }

  async getDualSidePosition(): Promise<boolean> {
    const { data } = await this.futuresClient.get('/fapi/v1/positionSide/dual', {
      params: this.signedParams()
    });
    return data.dualSidePosition; // true = 헤지 모드, false = 단방향 모드
  }

  async getOrder(symbol: string, orderId: number): Promise<any> {
    const { data } = await this.futuresClient.get('/fapi/v1/order', {
      params: this.signedParams({ symbol, orderId })
    });
    return data;
  }

  async getUserTrades(symbol: string, startTime?: number, limit = 50): Promise<any[]> {
    const params: Record<string, any> = { symbol, limit };
    if (startTime) params.startTime = startTime;
    const { data } = await this.futuresClient.get('/fapi/v1/userTrades', {
      params: this.signedParams(params)
    });
    return data;
  }

  // 전체 심볼 유지증거금률(MMR) 구간표를 한 번에 캐시 — 심볼 지정 호출도 weight 1이지만
  // 심볼 없이 호출하면 전체 심볼을 단 1번(weight 1)으로 받아올 수 있어 이 방식 사용
  // (승률검증처럼 후보 코인 수백 개를 백테스트할 때도 조회는 총 1번). 계좌별로 다르지 않고
  // (표준 티어 기준) 자주 안 바뀌므로 24시간 캐시.
  private static allBracketsCache: { data: Map<string, LeverageBracket[]>; ts: number } | null = null;
  private static readonly LEVERAGE_BRACKET_CACHE_TTL = 24 * 3_600_000;
  private static allBracketsInflight: Promise<Map<string, LeverageBracket[]>> | null = null;

  private async fetchAllLeverageBrackets(): Promise<Map<string, LeverageBracket[]>> {
    if (BinanceService.allBracketsCache && Date.now() - BinanceService.allBracketsCache.ts < BinanceService.LEVERAGE_BRACKET_CACHE_TTL) {
      return BinanceService.allBracketsCache.data;
    }
    // 캐시 만료 직후 여러 백테스트 워커가 동시에 걸리는 상황(40개 동시 실행) 대비 — 진행 중인 요청 공유
    if (BinanceService.allBracketsInflight) return BinanceService.allBracketsInflight;

    BinanceService.allBracketsInflight = (async () => {
      const { data } = await this.futuresClient.get('/fapi/v1/leverageBracket', {
        params: this.signedParams()
      });
      const map = new Map<string, LeverageBracket[]>(
        (data as any[]).map(entry => [
          entry.symbol,
          ((entry.brackets ?? []) as any[]).map(b => ({
            bracket: b.bracket, initialLeverage: b.initialLeverage,
            notionalCap: b.notionalCap, notionalFloor: b.notionalFloor,
            maintMarginRatio: b.maintMarginRatio, cum: b.cum
          }))
        ])
      );
      BinanceService.allBracketsCache = { data: map, ts: Date.now() };
      return map;
    })();

    try {
      return await BinanceService.allBracketsInflight;
    } finally {
      BinanceService.allBracketsInflight = null;
    }
  }

  async getLeverageBracket(symbol: string): Promise<LeverageBracket[]> {
    const all = await this.fetchAllLeverageBrackets();
    return all.get(symbol) ?? [];
  }
}

// 백테스트/가상거래는 실제 계좌 포지션이 없어 Binance가 실시간 청산가를 안 줌 —
// 거래 권한 없는 조회 전용 공용 키(BINANCE_API_KEY/SECRET, .env)로 유지증거금률 구간표를 조회해
// 청산가를 추정하는 용도로만 사용. 키가 없으면 getLeverageBracket 호출 시 인증 에러로 실패하고,
// 호출부는 이를 잡아 기존 방식(레버리지 기반 단순 추정)으로 폴백함
export const binanceMaster = new BinanceService(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);

// notional(포지션 규모)에 맞는 유지증거금률 구간 선택 — 백테스트처럼 브라켓을 심볼당 한 번만
// 조회해두고 캔들 루프 안에서는 네트워크 호출 없이 반복 재사용할 때 씀
export function pickLeverageBracket(brackets: LeverageBracket[], notionalUsdt: number): { mmr: number; cum: number } {
  if (brackets.length === 0) return { mmr: 0, cum: 0 };
  const b = brackets.find(x => notionalUsdt > x.notionalFloor && notionalUsdt <= x.notionalCap) ?? brackets[brackets.length - 1];
  return { mmr: b.maintMarginRatio, cum: b.cum };
}

// 심볼의 실제(마스터 키 있을 때) 또는 추정 청산가 — 실거래처럼 Binance가 직접 주는 liquidationPrice가
// 없는 상황(가상거래/신규 진입 전 미리보기)에서 사용
export async function estimateLiquidationPrice(
  symbol: string,
  marginUsdt: number,
  qty: number,
  avgEntryPrice: number,
  side: 'LONG' | 'SHORT' = 'SHORT'
): Promise<number | null> {
  try {
    const brackets = await binanceMaster.getLeverageBracket(symbol);
    if (brackets.length === 0) return null;
    const { mmr, cum } = pickLeverageBracket(brackets, qty * avgEntryPrice);
    return calcIsolatedLiquidationPrice(marginUsdt, qty, avgEntryPrice, mmr, cum, side);
  } catch {
    return null;
  }
}

export const binance = new BinanceService();

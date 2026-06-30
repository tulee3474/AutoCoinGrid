import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { Kline } from '../types';

const SPOT_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';
const TESTNET_FUTURES = 'https://testnet.binancefuture.com';

export class BinanceService {
  private apiKey: string;
  private apiSecret: string;
  private futuresBase: string;
  private spotClient: AxiosInstance;
  private futuresClient: AxiosInstance;
  private futuresSymbolsCache: Set<string> | null = null;
  private futuresSymbolsCachedAt = 0;
  private klinesCache = new Map<string, { data: Kline[]; ts: number }>();
  private static readonly KLINES_CACHE_TTL = 50_000; // 스캔 사이클(60s)보다 짧게 — 같은 사이클 내 전략/유저 간 중복 요청 방지

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
    const { data } = await this.futuresClient.get('/fapi/v1/klines', {
      params: { symbol, interval, limit }
    });
    return data.map((k: any[]) => ({
      openTime: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], volume: +k[5], closeTime: k[6]
    }));
  }

  async get24hrTickers(): Promise<any[]> {
    const { data } = await this.spotClient.get('/api/v3/ticker/24hr');
    return data;
  }

  async getFuturesExchangeInfo(): Promise<any> {
    const { data } = await this.futuresClient.get('/fapi/v1/exchangeInfo');
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

  async getFuturesPremiumIndex(): Promise<any[]> {
    const { data } = await this.futuresClient.get('/fapi/v1/premiumIndex');
    return data;
  }

  // ── 인증 필요 API ────────────────────────────────────────────

  async getAccountInfo(): Promise<any> {
    const { data } = await this.futuresClient.get('/fapi/v2/account', {
      params: this.signedParams()
    });
    return data;
  }

  async getPositions(): Promise<any[]> {
    const { data } = await this.futuresClient.get('/fapi/v2/positionRisk', {
      params: this.signedParams()
    });
    return (data as any[]).filter(p => parseFloat(p.positionAmt) !== 0);
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
}

export const binance = new BinanceService();

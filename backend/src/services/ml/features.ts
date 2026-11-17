import { Kline, StrategyConditions } from '../../types';
import { calcRSI } from '../indicator';
import { FundingRateRow, SeriesRow } from '../binance';
import { selectTopVolume } from '../candidateFilter';

// ── AI 진입 필터 입력값 (학습/실전 공통) ─────────────────────────
// 학습(과거 백테스트 진입 시점)과 실전(스캐너 신호 시점)이 반드시 같은 함수로 계산해야 모델이 의미 있음.
// 전략 타임프레임과 무관하게 항상 1h 캔들 기준 — 전략마다 입력 정의가 달라지지 않도록 고정.
// 시점 T 기준 "T 이전에 시작한 캔들"만 사용 (학습: T=진입 캔들 시작 → 직전 캔들까지 완성봉,
// 실전: T=지금 → 진행 중인 현재 캔들 포함. 이 정도 차이는 감수)
// 값을 알 수 없으면 NaN (모델이 결측 처리 — gbdt.ts)

export const FEATURE_NAMES = [
  'ret_1h', 'ret_4h', 'ret_24h', 'ret_72h', 'ret_7d',
  'rsi_1h',
  'vol_ratio_24h',        // 최근 24h 거래량 / 그 이전 6일 하루 평균
  'log_quote_vol_24h',    // 최근 24h 거래대금(USDT) log10 — 유동성
  'from_high_7d',         // 7일 고점 대비 현재가 (%)
  'from_low_7d',          // 7일 저점 대비 현재가 (%) — 바닥에서 얼마나 펌핑됐나
  'volatility_24h',       // 1h 수익률 표준편차 (%)
  'upper_wick',           // 직전 캔들 윗꼬리 비율 (0~1)
  'green_streak',         // 연속 양봉 수
  'btc_ret_4h', 'btc_ret_24h',
  'funding_rate',         // 직전 정산 펀딩비 (%)
  'listing_days',         // 선물 상장 후 경과일 (최대 400)
  // ── v2 추가: 진입 조건(가격·RSI)과 겹치지 않는 정보 ──
  'taker_buy_4h',         // 최근 4h 거래량 중 시장가 매수 비율 (0~1) — 매수 압력
  'taker_buy_24h',
  'oi_chg_4h',            // 미결제약정(USDT) 4h 변화율 (%) — 신규 포지션 유입 vs 숏 청산 펌핑 구분
  'oi_chg_24h',
  'ls_ratio',             // 전체 계정 롱/숏 비율 — 롱 쏠림
  'ls_chg_24h',           // 롱숏비율 24h 변화율 (%)
  'alt_med_ret_24h',      // 후보 알트 전체의 24h 수익률 중앙값 (%) — 시장 분위기
  'alt_pump_frac_24h',    // 후보 알트 중 24h +10% 이상 비율 (0~1) — 펌핑 장세 여부
  'hour_utc',             // 진입 시각 (UTC 0~23)
  'dow_utc',              // 요일 (0=일 ~ 6=토)
] as const;

export const BREADTH_IDX = { med: FEATURE_NAMES.indexOf('alt_med_ret_24h'), frac: FEATURE_NAMES.indexOf('alt_pump_frac_24h') };

// 한국어 표시용 (프론트 중요도 차트)
export const FEATURE_LABELS: Record<string, string> = {
  ret_1h: '1시간 상승률', ret_4h: '4시간 상승률', ret_24h: '24시간 상승률', ret_72h: '3일 상승률', ret_7d: '7일 상승률',
  rsi_1h: 'RSI(1h)', vol_ratio_24h: '거래량 배수(24h)', log_quote_vol_24h: '거래대금 규모',
  from_high_7d: '7일 고점 대비', from_low_7d: '7일 저점 대비', volatility_24h: '변동성(24h)',
  upper_wick: '윗꼬리 비율', green_streak: '연속 양봉', btc_ret_4h: 'BTC 4시간', btc_ret_24h: 'BTC 24시간',
  funding_rate: '펀딩비', listing_days: '상장 경과일',
  taker_buy_4h: '시장가 매수 비율(4h)', taker_buy_24h: '시장가 매수 비율(24h)',
  oi_chg_4h: '미결제약정 변화(4h)', oi_chg_24h: '미결제약정 변화(24h)',
  ls_ratio: '롱숏 계정 비율', ls_chg_24h: '롱숏비율 변화(24h)',
  alt_med_ret_24h: '알트 시장 24h 중앙값', alt_pump_frac_24h: '알트 펌핑 비율',
  hour_utc: '시간대(UTC)', dow_utc: '요일',
};

const H = 3_600_000;

const ret = (closes: number[], n: number) => {
  const last = closes.length - 1;
  const base = closes[Math.max(0, last - n)];
  return base > 0 ? (closes[last] / base - 1) * 100 : 0;
};

// openTime < T 인 마지막 캔들 인덱스 (오름차순 정렬 가정), 없으면 -1
export function lastIndexBefore(klines: Kline[], T: number): number {
  let lo = 0, hi = klines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (klines[mid].openTime < T) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function fundingRateAt(rows: FundingRateRow[] | null, T: number): number {
  if (!rows || rows.length === 0) return 0;
  let rate = 0;
  for (const r of rows) { if (r.fundingTime <= T) rate = r.fundingRate; else break; }
  return rate * 100;
}

// t < T 인 마지막 값. 그 값이 maxAge보다 오래됐으면(데이터 공백·30일 이전) NaN
function seriesAt(rows: SeriesRow[] | null, T: number, maxAge = 2 * H): number {
  if (!rows || rows.length === 0) return NaN;
  let lo = 0, hi = rows.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < T) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0 || T - rows[ans].t > maxAge) return NaN;
  return rows[ans].v;
}
const pctChange = (now: number, before: number) => (before > 0 && Number.isFinite(now) ? (now / before - 1) * 100 : NaN);

// ── 시장 분위기 (후보 알트 전체의 24h 수익률 분포) ─────────────────
export interface Breadth { med: number; frac: number }
// 시점 T의 분위기 = T 직전 완성 1h 캔들(시작 시각 = 이 키) 기준
export const breadthKey = (T: number) => Math.floor((T - 1) / H) * H;
export function breadthOf(rets24Pct: number[]): Breadth | null {
  if (rets24Pct.length < 20) return null;
  const s = [...rets24Pct].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return {
    med: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    frac: s.filter(v => v >= 10).length / s.length,
  };
}

// 후보 코인: 전략 검증(validate)·학습·실전 분위기 계산이 같은 기준을 씀
const EXCLUDE = new Set(['BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'BUSDUSDT', 'TUSDUSDT', 'FDUSDUSDT', 'USDTUSDT', 'DAIUSDT', 'WBTCUSDT', 'BTCBUSDT', 'WBETHUSDT', 'LDOUSDT']);
export function selectCandidateTickers(tickers: any[], onboardDates: Map<string, number>, conditions: StrategyConditions): any[] {
  const minListingMs = conditions.minListingDays ? conditions.minListingDays * 86_400_000 : 0;
  return selectTopVolume(
    tickers.filter(t => {
      if (!t.symbol.endsWith('USDT') || EXCLUDE.has(t.symbol)) return false;
      if (parseFloat(t.quoteVolume) <= 200_000) return false;
      if (minListingMs > 0) {
        const ob = onboardDates.get(t.symbol);
        if (ob && Date.now() - ob < minListingMs) return false;
      }
      return true;
    }),
    conditions.candidateTopPct
  );
}

export interface FeatureExtras {
  oi?: SeriesRow[] | null;        // 미결제약정 1h 이력
  ls?: SeriesRow[] | null;        // 롱숏비율 1h 이력
  breadth?: Breadth | null;
}

/**
 * @param coin1h  대상 코인 1h 캔들 (오름차순, 시점 T 이후 캔들이 섞여 있어도 됨 — 내부에서 잘라냄)
 * @param btc1h   BTCUSDT 1h 캔들 (동일)
 * @returns 입력값 배열 (FEATURE_NAMES 순서, 모르는 값은 NaN) 또는 캔들이 너무 적으면 null
 */
export function computeFeatures(
  coin1h: Kline[], btc1h: Kline[], T: number, fundingRatePct: number, onboardDate: number | undefined, extras: FeatureExtras = {}
): number[] | null {
  const end = lastIndexBefore(coin1h, T);
  if (end < 24) return null;                                  // 최소 하루치는 있어야 함
  const ks = coin1h.slice(Math.max(0, end - 199), end + 1);  // 최근 최대 200개
  const closes = ks.map(k => k.close);
  const last = ks[ks.length - 1];

  const vol24   = ks.slice(-24).reduce((a, k) => a + k.volume, 0);
  const prev    = ks.slice(-168, -24);
  const prevAvg = prev.length > 0 ? prev.reduce((a, k) => a + k.volume, 0) / (prev.length / 24) : vol24;
  const quote24 = ks.slice(-24).reduce((a, k) => a + k.volume * k.close, 0);

  const w7  = ks.slice(-168);
  const hi7 = Math.max(...w7.map(k => k.high));
  const lo7 = Math.min(...w7.map(k => k.low));

  const rets = closes.slice(-25).map((c, i, a) => i === 0 ? 0 : Math.log(c / a[i - 1])).slice(1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vola = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * 100;

  const range = last.high - last.low;
  const upperWick = range > 0 ? (last.high - Math.max(last.open, last.close)) / range : 0;

  let streak = 0;
  for (let i = ks.length - 1; i >= 0 && streak < 24; i--) {
    if (ks[i].close > ks[i].open) streak++; else break;
  }

  const bEnd = lastIndexBefore(btc1h, T);
  const bCloses = bEnd >= 0 ? btc1h.slice(Math.max(0, bEnd - 24), bEnd + 1).map(k => k.close) : [1];

  const listingDays = onboardDate ? Math.min(400, Math.max(0, (T - onboardDate) / 86_400_000)) : 400;

  const takerRatio = (n: number) => {
    const w = ks.slice(-n);
    if (w.some(k => k.takerBuyVolume === undefined || Number.isNaN(k.takerBuyVolume))) return NaN;
    const v = w.reduce((a, k) => a + k.volume, 0);
    return v > 0 ? w.reduce((a, k) => a + k.takerBuyVolume!, 0) / v : NaN;
  };

  const oiNow = seriesAt(extras.oi ?? null, T);
  const lsNow = seriesAt(extras.ls ?? null, T);
  const d = new Date(T);

  return [
    ret(closes, 1), ret(closes, 4), ret(closes, 24), ret(closes, 72), ret(closes, 168),
    calcRSI(closes, 14),
    prevAvg > 0 ? vol24 / prevAvg : 1,
    Math.log10(Math.max(1, quote24)),
    hi7 > 0 ? (last.close / hi7 - 1) * 100 : 0,
    lo7 > 0 ? (last.close / lo7 - 1) * 100 : 0,
    vola,
    upperWick,
    streak,
    ret(bCloses, 4), ret(bCloses, 24),
    fundingRatePct,
    listingDays,
    takerRatio(4), takerRatio(24),
    pctChange(oiNow, seriesAt(extras.oi ?? null, T - 4 * H)),
    pctChange(oiNow, seriesAt(extras.oi ?? null, T - 24 * H)),
    lsNow,
    pctChange(lsNow, seriesAt(extras.ls ?? null, T - 24 * H)),
    extras.breadth?.med ?? NaN,
    extras.breadth?.frac ?? NaN,
    d.getUTCHours(),
    d.getUTCDay(),
  ];
}

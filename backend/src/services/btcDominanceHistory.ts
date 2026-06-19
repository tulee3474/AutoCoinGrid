/**
 * BTC 도미넌스 역사적 데이터 서비스
 * backend/data/btc_dominance.csv 파일에서 데이터를 로드합니다.
 *
 * 지원 CSV 형식 (첫 줄은 헤더로 자동 감지):
 *   date,dominance
 *   2024-01-15,52.3
 *
 * 또는 CoinMarketCap 내보내기 형식:
 *   "Jan 15, 2024","52.34%"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR  = join(__dirname, '../../data');
export const CSV_PATH = join(DATA_DIR, 'btc_dominance.csv');

// 메모리 캐시 (Map<'YYYY-MM-DD', dominance%>)
let cache: Map<string, number> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL = 30_000; // 30초마다 파일 재읽기

// ── 날짜 파서 ──────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/['"]/g, '');

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;

  // "Jan 15, 2024" / "January 15, 2024"
  const words = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (words) {
    const mo = MONTHS[words[1].toLowerCase().slice(0, 3)];
    if (mo) return `${words[3]}-${mo}-${words[2].padStart(2, '0')}`;
  }

  return null;
}

function parseDominance(raw: string): number | null {
  const s = raw.trim().replace(/['"% ]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── CSV 로드 ───────────────────────────────────────────────────

function loadFromFile(): Map<string, number> {
  const map = new Map<string, number>();
  if (!existsSync(CSV_PATH)) return map;

  const lines = readFileSync(CSV_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 헤더 감지 (첫 필드가 숫자로 시작하지 않으면 스킵)
    const firstChar = trimmed.replace(/["']/g, '')[0];
    if (firstChar && !/\d/.test(firstChar) && !/[A-Z]/i.test(firstChar)) continue;

    const parts = trimmed.split(',');
    if (parts.length < 2) continue;

    const date = parseDate(parts[0]);
    const dom  = parseDominance(parts[1]);
    if (date && dom !== null) map.set(date, dom);
  }
  return map;
}

function getCache(): Map<string, number> {
  if (!cache || Date.now() - cacheLoadedAt > CACHE_TTL) {
    cache = loadFromFile();
    cacheLoadedAt = Date.now();
  }
  return cache;
}

// ── 공개 API ───────────────────────────────────────────────────

/**
 * 특정 타임스탬프(ms)의 BTC 도미넌스를 반환합니다.
 * 데이터가 없으면 null → 백테스트에서 조건 건너뜀
 */
export function getDominanceAt(timestampMs: number): number | null {
  const date = new Date(timestampMs).toISOString().slice(0, 10);
  const map = getCache();
  return map.has(date) ? map.get(date)! : null;
}

export function getDataInfo() {
  const map = getCache();
  if (map.size === 0) return { count: 0, dateRange: null, hasData: false };
  const dates = [...map.keys()].sort();
  return {
    count: map.size,
    dateRange: `${dates[0]} ~ ${dates[dates.length - 1]}`,
    hasData: true,
    oldest: dates[0],
    newest: dates[dates.length - 1]
  };
}

export function saveCSV(csvContent: string): { saved: number; errors: number } {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const lines = csvContent.split('\n');
  const rows: string[] = [];
  let saved = 0, errors = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 2) { errors++; continue; }

    const date = parseDate(parts[0]);
    const dom  = parseDominance(parts[1]);
    if (!date || dom === null) { errors++; continue; }

    rows.push(`${date},${dom.toFixed(2)}`);
    saved++;
  }

  // 날짜순 정렬 후 저장
  rows.sort();
  writeFileSync(CSV_PATH, ['date,dominance', ...rows].join('\n'), 'utf-8');
  cache = null; // 캐시 무효화
  return { saved, errors };
}

export function deleteCSV() {
  const { unlinkSync } = require('fs');
  if (existsSync(CSV_PATH)) unlinkSync(CSV_PATH);
  cache = null;
}

// Demo 플랜에서 사용 가능한 상위 10개 코인으로 전체 시총 근사
// BTC 도미넌스 = BTC 시총 / 전체 시총 × 100
// 보정: 오늘 /global의 실제 도미넌스와 비교해 스케일 팩터 적용 → 오차 ±3~5%
const TRACKED_COINS = [
  'bitcoin', 'ethereum', 'tether', 'binancecoin', 'solana',
  'ripple', 'usd-coin', 'cardano', 'dogecoin', 'tron'
];

export async function fetchFromCoinGecko(days = 365): Promise<{
  saved: number;
  dateRange: string | null;
  error?: string;
}> {
  const axios = (await import('axios')).default;

  const apiKey = process.env.COINGECKO_API_KEY;
  const isPro  = process.env.COINGECKO_PLAN === 'pro';
  const baseUrl = isPro
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const authHeaders: Record<string, string> = apiKey
    ? { [isPro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: apiKey }
    : {};
  const req = (url: string, params?: object) =>
    axios.get(url, { params, timeout: 15_000, headers: { Accept: 'application/json', ...authHeaders } });

  try {
    // 1. 오늘의 실제 BTC 도미넌스 (보정용)
    const globalRes = await req(`${baseUrl}/global`);
    const actualDominanceToday: number =
      globalRes.data?.data?.market_cap_percentage?.btc ?? 0;
    if (actualDominanceToday === 0) {
      return { saved: 0, dateRange: null, error: 'CoinGecko /global 응답 오류' };
    }

    // 2. 상위 10개 코인 시총 히스토리 수집 (순차 호출 — rate limit 대응)
    const coinData = new Map<string, Map<string, number>>(); // coinId → (date → mcap)

    for (const coinId of TRACKED_COINS) {
      try {
        const r = await req(`${baseUrl}/coins/${coinId}/market_chart`, {
          vs_currency: 'usd', days, interval: 'daily'
        });
        const mcaps: [number, number][] = r.data.market_caps ?? [];
        const dateMap = new Map<string, number>();
        for (const [ts, mcap] of mcaps) {
          dateMap.set(new Date(ts).toISOString().slice(0, 10), mcap);
        }
        coinData.set(coinId, dateMap);
      } catch {
        // 개별 코인 실패 시 스킵
      }
      // CoinGecko Demo: 30 req/min → 코인당 300ms 대기
      await new Promise(r => setTimeout(r, 350));
    }

    const btcData = coinData.get('bitcoin');
    if (!btcData || btcData.size === 0) {
      return { saved: 0, dateRange: null, error: 'BTC 시총 데이터 없음' };
    }

    // 3. 날짜별 전체 시총 합산 (상위 10개 기준)
    const totalByDate = new Map<string, number>();
    for (const [, dateMap] of coinData) {
      for (const [date, mcap] of dateMap) {
        totalByDate.set(date, (totalByDate.get(date) ?? 0) + mcap);
      }
    }

    // 4. 보정 계수 계산 (오늘 기준)
    const allDates   = [...btcData.keys()].sort();
    const latestDate = allDates[allDates.length - 1];
    const btcToday   = btcData.get(latestDate) ?? 0;
    const sumToday   = totalByDate.get(latestDate) ?? 0;
    const calcToday  = sumToday > 0 ? (btcToday / sumToday) * 100 : 0;
    const corrFactor = calcToday > 0 ? actualDominanceToday / calcToday : 1;

    // 5. 날짜별 도미넌스 계산
    const rows: string[] = [];
    for (const date of allDates) {
      const btcMcap   = btcData.get(date) ?? 0;
      const totalMcap = totalByDate.get(date) ?? 0;
      if (btcMcap > 0 && totalMcap > 0) {
        const dominance = Math.min(Math.max((btcMcap / totalMcap) * 100 * corrFactor, 0), 100);
        rows.push(`${date},${dominance.toFixed(2)}`);
      }
    }

    if (rows.length === 0) {
      return { saved: 0, dateRange: null, error: '도미넌스 계산 실패' };
    }

    // 6. 기존 데이터와 병합 후 저장
    const existing = getCache();
    const merged   = new Map(existing);
    for (const row of rows) {
      const [date, dom] = row.split(',');
      merged.set(date, parseFloat(dom));
    }

    const sorted = [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(
      CSV_PATH,
      ['date,dominance', ...sorted.map(([d, v]) => `${d},${v.toFixed(2)}`)].join('\n'),
      'utf-8'
    );
    cache = null;

    const dates = sorted.map(r => r[0]);
    return {
      saved:     sorted.length,
      dateRange: `${dates[0]} ~ ${dates[dates.length - 1]}`
    };
  } catch (e: any) {
    const status = e.response?.status;
    const msg = status === 429
      ? 'CoinGecko 요청 한도 초과 (1분 후 재시도)'
      : status === 401
      ? `CoinGecko 인증 실패 — API 키를 확인하세요 (키: ${(process.env.COINGECKO_API_KEY ?? '미설정').slice(0, 8)}...)`
      : e.message;
    return { saved: 0, dateRange: null, error: msg };
  }
}

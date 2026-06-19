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

/**
 * CoinGecko 무료 공개 API로 최근 N일간 BTC 도미넌스를 자동 수집합니다.
 * - BTC 시가총액: /coins/bitcoin/market_chart
 * - 전체 시가총액: /global/market_cap_chart
 * - 도미넌스 = BTC 시총 / 전체 시총 × 100
 */
export async function fetchFromCoinGecko(days = 365): Promise<{
  saved: number;
  dateRange: string | null;
  error?: string;
}> {
  const axios = (await import('axios')).default;

  // API 키가 있으면 헤더에 추가 (Demo: CG-xxx, Pro: 별도 키)
  const apiKey = process.env.COINGECKO_API_KEY;
  const isPro  = process.env.COINGECKO_PLAN === 'pro';
  const baseUrl = isPro
    ? 'https://pro-api.coingecko.com/api/v3'
    : 'https://api.coingecko.com/api/v3';
  const authHeaders: Record<string, string> = apiKey
    ? { [isPro ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key']: apiKey }
    : {};

  try {
    // 두 API를 병렬 호출
    const [btcRes, globalRes] = await Promise.all([
      axios.get(`${baseUrl}/coins/bitcoin/market_chart`, {
        params: { vs_currency: 'usd', days, interval: 'daily' },
        timeout: 20_000,
        headers: { Accept: 'application/json', ...authHeaders }
      }),
      axios.get(`${baseUrl}/global/market_cap_chart`, {
        params: { days },
        timeout: 20_000,
        headers: { Accept: 'application/json', ...authHeaders }
      })
    ]);

    // [[timestamp_ms, value], ...] 형식
    const btcMcaps:   [number, number][] = btcRes.data.market_caps    ?? [];
    const totalMcaps: [number, number][] = globalRes.data.market_cap_chart?.market_cap ?? [];

    if (btcMcaps.length === 0 || totalMcaps.length === 0) {
      return { saved: 0, dateRange: null, error: 'CoinGecko 응답 데이터 없음' };
    }

    // 전체 시총을 날짜→값 맵으로 변환
    const totalMap = new Map<string, number>();
    for (const [ts, mcap] of totalMcaps) {
      const date = new Date(ts).toISOString().slice(0, 10);
      totalMap.set(date, mcap);
    }

    // 날짜별 도미넌스 계산
    const rows: string[] = [];
    for (const [ts, btcMcap] of btcMcaps) {
      const date = new Date(ts).toISOString().slice(0, 10);
      const totalMcap = totalMap.get(date);
      if (totalMcap && totalMcap > 0) {
        const dominance = (btcMcap / totalMcap) * 100;
        rows.push(`${date},${dominance.toFixed(2)}`);
      }
    }

    if (rows.length === 0) {
      return { saved: 0, dateRange: null, error: '도미넌스 계산 실패: 날짜 매핑 없음' };
    }

    // 기존 데이터와 병합 (더 오래된 데이터가 있으면 유지)
    const existing = getCache();
    const merged = new Map(existing);
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
      saved: sorted.length,
      dateRange: `${dates[0]} ~ ${dates[dates.length - 1]}`
    };
  } catch (e: any) {
    const status = e.response?.status;
    const apiKey = process.env.COINGECKO_API_KEY;
    let msg: string;
    if (status === 429) {
      msg = 'CoinGecko 요청 한도 초과 (1분 후 재시도)';
    } else if (status === 401) {
      msg = apiKey
        ? `CoinGecko 인증 실패 (키: ${apiKey.slice(0, 8)}...) — Demo 플랜에서 /global/market_cap_chart 미지원일 수 있음`
        : 'COINGECKO_API_KEY 환경변수 미로드 — 컨테이너 재생성 필요 (docker compose up -d --force-recreate)';
    } else {
      msg = e.message;
    }
    return { saved: 0, dateRange: null, error: msg };
  }
}

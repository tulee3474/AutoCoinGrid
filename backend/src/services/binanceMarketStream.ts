import WebSocket from 'ws';

// Binance 선물 전체 심볼 마크 가격을 실시간으로 받는 공유 웹소켓 스트림.
// 계정별 상태가 전혀 없는 공개 데이터라 프로세스당 연결 1개만 유지하면 됨 —
// 이게 healthy한 동안은 binance.ts의 getFuturesPremiumIndex()가 REST 폴링 대신 이 캐시를 씀.

// 2026-04-23 Binance WS 마이그레이션으로 markPrice는 /market 라우팅 경로 필수 —
// 라우팅 없는 구 경로(/ws/...)로는 핸드셰이크는 성공하지만 /market 소속 스트림(markPrice 포함)
// 데이터가 전혀 오지 않음 (공개 /public 스트림만 수신됨). 인증/과금과 무관한 순수 URL 문제.
const STREAM_URL = process.env.USE_TESTNET === 'true'
  ? 'wss://stream.binancefuture.com/market/ws/!markPrice@arr@1s'
  : 'wss://fstream.binance.com/market/ws/!markPrice@arr@1s';

const STALE_AFTER_MS = 15_000;      // 이 시간 동안 메시지 없으면 죽은 연결로 간주하고 강제 재연결
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const markPrices = new Map<string, { price: number; ts: number }>();

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let started = false;

// 강제 재연결 시 옛 소켓의 close/error 핸들러가 뒤늦게 발화해 새로 연 연결과
// 경합하며 계속 재연결을 반복하는 걸 막기 위한 세대(generation) 토큰 —
// 세대가 다른 소켓에서 온 이벤트는 전부 무시
let connGeneration = 0;

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts) + Math.random() * 1000;
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  const myGen = ++connGeneration;

  let socket: WebSocket;
  try {
    socket = new WebSocket(STREAM_URL);
  } catch (e: any) {
    console.error(`[MarkPriceStream] 연결 생성 실패: ${e.message}`);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.on('open', () => {
    if (myGen !== connGeneration) return;
    reconnectAttempts = 0;
    lastMessageAt = Date.now();
    console.log('[MarkPriceStream] connected');
  });

  socket.on('message', (raw) => {
    if (myGen !== connGeneration) return;
    lastMessageAt = Date.now();
    try {
      const arr = JSON.parse(raw.toString());
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        // 축약 필드: s=symbol, p=markPrice
        if (m?.s && m?.p) markPrices.set(m.s, { price: parseFloat(m.p), ts: lastMessageAt });
      }
    } catch { /* 파싱 실패한 메시지는 무시 */ }
  });

  socket.on('close', () => {
    if (myGen !== connGeneration) return; // 이미 대체된(강제 재연결된) 옛 소켓의 뒤늦은 이벤트
    console.log('[MarkPriceStream] disconnected — 재연결 예약');
    scheduleReconnect();
  });

  socket.on('error', (e: any) => {
    if (myGen !== connGeneration) return;
    console.error(`[MarkPriceStream] 오류: ${e.message}`);
  });
}

// 소켓이 죽었는데 close 이벤트가 안 오는 경우(네트워크 행 등) 대비.
// generation을 먼저 올려 옛 소켓의 이벤트를 무효화한 뒤 종료 + 재연결 — close 핸들러와
// 중복으로 재연결을 스케줄하지 않도록 함
function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (lastMessageAt > 0 && Date.now() - lastMessageAt > STALE_AFTER_MS) {
      console.log('[MarkPriceStream] stale — 강제 재연결');
      const staleSocket = ws;
      connGeneration++; // 옛 소켓의 이후 이벤트(close 포함)는 전부 무시됨
      lastMessageAt = 0;
      try { staleSocket?.terminate(); } catch { /* noop */ }
      connect();
    }
  }, WATCHDOG_INTERVAL_MS);
}

export function startMarkPriceStream(): void {
  if (started) return;
  started = true;
  connect();
  startWatchdog();
}

export function stopMarkPriceStream(): void {
  started = false;
  connGeneration++; // 남아있는 소켓의 이벤트 전부 무효화
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (watchdogTimer)  { clearInterval(watchdogTimer); watchdogTimer = null; }
  try { ws?.close(); } catch { /* noop */ }
  ws = null;
}

export function getAllMarkPrices(): Map<string, number> {
  const result = new Map<string, number>();
  for (const [symbol, { price }] of markPrices) result.set(symbol, price);
  return result;
}

export function isMarkPriceStreamHealthy(): boolean {
  return markPrices.size > 0 && Date.now() - lastMessageAt < 5_000;
}

import { binance } from './binance';
import { scanMarket } from './scanner';
import { openPaperPosition, closePaperPosition, getOrCreateWallet } from './paperWallet';
import { StrategyConfig, StrategyConditions, TradeConfig } from '../types';
import prisma from '../lib/prisma';

const SCAN_INTERVAL_MS = 60_000;

// ── 타입 ──────────────────────────────────────────────────────

type LogType = 'info' | 'signal' | 'close' | 'error';
interface LogEntry { time: number; message: string; type: LogType }

interface ScannerState {
  interval: NodeJS.Timeout;
  log: LogEntry[];
}

// ── per-user 스캐너 Map ───────────────────────────────────────

const scanners = new Map<string, ScannerState>();

function getLog(userId: string): LogEntry[] {
  return scanners.get(userId)?.log ?? [];
}

function addLog(userId: string, message: string, type: LogType = 'info') {
  const state = scanners.get(userId);
  if (!state) return;
  state.log.unshift({ time: Date.now(), message, type });
  if (state.log.length > 100) state.log.pop();
  console.log(`[Scanner:${userId.slice(0, 6)}] ${message}`);
}

// ── BTC 도미넌스 캐시 (전역, 5분) ────────────────────────────

let cachedDom = 50;
let domFetchedAt = 0;

async function getBtcDominance(): Promise<number> {
  if (Date.now() - domFetchedAt < 5 * 60_000) return cachedDom;
  try {
    const { default: axios } = await import('axios');
    const { data } = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 });
    cachedDom = data.data?.market_cap_percentage?.btc ?? 50;
    domFetchedAt = Date.now();
  } catch { /* 캐시 유지 */ }
  return cachedDom;
}

// ── 전략 로드 (DB) ────────────────────────────────────────────

async function loadStrategies(userId: string): Promise<StrategyConfig[]> {
  const rows = await prisma.strategy.findMany({ where: { userId, enabled: true } });
  return rows.map(r => ({
    id:         r.id,
    name:       r.name,
    enabled:    r.enabled,
    coins:      r.coins as string[],
    conditions: r.conditions as unknown as StrategyConditions,
    trade:      r.trade as unknown as TradeConfig,
    createdAt:  r.createdAt.getTime()
  }));
}

// ── 스캔 사이클 ───────────────────────────────────────────────

async function runScanCycle(userId: string, broadcast: (data: unknown) => void) {
  const now = new Date().toLocaleTimeString('ko');

  // 1. 오픈 포지션 TP/SL/타임아웃 체크
  const wallet = await getOrCreateWallet(userId);
  if (wallet.openPositions.length > 0) {
    try {
      const tickers  = await binance.get24hrTickers() as any[];
      const priceMap = new Map<string, number>(tickers.map((t: any) => [t.symbol, parseFloat(t.lastPrice)]));

      for (const pos of wallet.openPositions) {
        const price = priceMap.get(pos.symbol);
        if (!price) continue;

        let exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | null = null;
        if      (price <= pos.takeProfitPrice)         exitReason = 'takeProfit';
        else if (price >= pos.stopLossPrice)            exitReason = 'stopLoss';
        else if (Date.now() >= pos.expiresAt.getTime()) exitReason = 'timeout';

        if (exitReason) {
          const log = await closePaperPosition(userId, pos.id, price, exitReason);
          if (log) {
            const emoji = exitReason === 'takeProfit' ? '✅' : exitReason === 'stopLoss' ? '❌' : '⏰';
            addLog(userId,
              `${emoji} [청산] ${pos.symbol} (${exitReason}) ${log.pnlPct >= 0 ? '+' : ''}${log.pnlPct.toFixed(2)}% | $${log.pnlUsdt.toFixed(2)}`,
              'close'
            );
            broadcast({ type: 'paper_close', data: log });
          }
        }
      }
    } catch (e: any) {
      addLog(userId, `포지션 체크 오류: ${e.message}`, 'error');
    }
  }

  // 2. 활성 전략으로 신호 스캔 → 신규 진입
  const strategies = await loadStrategies(userId);
  if (strategies.length === 0) {
    addLog(userId, `[${now}] 활성 전략 없음`);
    broadcast({ type: 'paper_scan', data: { signals: [], message: '활성 전략 없음' } });
    return;
  }

  const btcDom = await getBtcDominance();

  for (const strategy of strategies) {
    try {
      const signals     = await scanMarket(strategy.conditions, btcDom);
      const fullSignals = signals.filter(s => s.signalScore >= 100);

      addLog(userId, `[${now}] 전략 "${strategy.name}": 후보 ${signals.length}개, 충족 ${fullSignals.length}개`);

      for (const signal of fullSignals) {
        const pos = await openPaperPosition(userId, signal.symbol, signal.price, strategy.trade, strategy.name);
        if (pos) {
          addLog(userId,
            `📈 [진입] ${signal.symbol} @ $${signal.price.toPrecision(5)} | TP $${pos.takeProfitPrice.toPrecision(4)} | SL $${pos.stopLossPrice.toPrecision(4)}`,
            'signal'
          );
          broadcast({ type: 'paper_signal', data: { position: pos, signal } });
        }
      }

      broadcast({ type: 'paper_scan', data: { signals: fullSignals, scannedAt: Date.now() } });
    } catch (e: any) {
      addLog(userId, `전략 "${strategy.name}" 스캔 오류: ${e.message}`, 'error');
    }
  }
}

// ── 공개 API ─────────────────────────────────────────────────

export function isPaperRunning(userId: string) {
  return scanners.has(userId);
}

export function getPaperLog(userId: string) {
  return getLog(userId);
}

export function startPaperScanner(userId: string, broadcast: (data: unknown) => void) {
  if (scanners.has(userId)) return;

  const state: ScannerState = {
    log: [],
    interval: setInterval(
      () => runScanCycle(userId, broadcast).catch(e => addLog(userId, `스캔 오류: ${e.message}`, 'error')),
      SCAN_INTERVAL_MS
    )
  };
  scanners.set(userId, state);

  addLog(userId, '🚀 가상 스캐너 시작 (1분 간격)', 'info');
  runScanCycle(userId, broadcast).catch(e => addLog(userId, `초기 스캔 오류: ${e.message}`, 'error'));
}

export function stopPaperScanner(userId: string) {
  const state = scanners.get(userId);
  if (!state) return;
  clearInterval(state.interval);
  scanners.delete(userId);
  console.log(`[Scanner:${userId.slice(0, 6)}] 중지됨`);
}

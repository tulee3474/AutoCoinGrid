import { binance } from './binance';
import { scanMarket } from './scanner';
import { openPaperPosition, closePaperPosition, getOrCreateWallet } from './paperWallet';
import { computeIndicators } from './indicator';
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

// ── RSI 조회 헬퍼 (기본 1h, getFuturesKlines 캐시 공유) ────────

async function fetchRsi14(symbol: string, interval: string = '1h'): Promise<number | null> {
  try {
    const klines = await binance.getFuturesKlines(symbol, interval, 60);
    if (klines.length < 20) return null;
    return computeIndicators(klines, interval).rsi14;
  } catch {
    return null;
  }
}

// ── 스캔 사이클 ───────────────────────────────────────────────

async function runScanCycle(userId: string, broadcast: (data: unknown) => void) {
  const now = new Date().toLocaleTimeString('ko');

  // 1. 오픈 포지션 TP/SL/타임아웃 체크
  const [wallet, strategies] = await Promise.all([
    getOrCreateWallet(userId),
    loadStrategies(userId)
  ]);

  // 전략명 → rsiExitThreshold 맵 (포지션별 임계값 조회용)
  const strategyThresholdMap = new Map<string, number | null>(
    strategies.map(s => [s.name, s.trade.rsiExitThreshold ?? null])
  );
  // 전략명 → gridRsiSkipThreshold 맵 (그리드 체결 시점 RSI 과열 판단용)
  const strategyGridSkipMap = new Map<string, number | null>(
    strategies.map(s => [s.name, s.trade.gridRsiSkipThreshold ?? null])
  );

  if (wallet.openPositions.length > 0) {
    try {
      // 현물 lastPrice가 아니라 선물 markPrice 기준 — Binance 실거래 트리거/표시 가격과 일치시키고
      // 현물에 상장 안 된 선물 전용 코인도 정확히 매칭하기 위함
      const indices  = await binance.getFuturesPremiumIndex() as any[];
      const priceMap = new Map<string, number>(indices.map((m: any) => [m.symbol, parseFloat(m.markPrice)]));

      // 심볼별로 포지션 오픈 시각부터 현재까지의 1h 캔들 미리 조회 (SL/TP 누락 감지용)
      const klinesBySymbol = new Map<string, Awaited<ReturnType<typeof binance.getKlines>>>();
      for (const sym of new Set(wallet.openPositions.map(p => p.symbol))) {
        const oldestMs = Math.min(
          ...wallet.openPositions.filter(p => p.symbol === sym).map(p => p.openedAt.getTime())
        );
        try {
          // 선물 전용 상장 코인은 스팟 캔들이 없어 소급 감지가 통째로 비었던 문제 — 선물 캔들로 통일
          klinesBySymbol.set(sym, await binance.getFuturesKlinesSince(sym, '1h', oldestMs));
        } catch { klinesBySymbol.set(sym, []); }
      }

      for (const pos of wallet.openPositions) {
        const price = priceMap.get(pos.symbol);
        if (!price) continue;

        // 이 포지션 오픈 이후 캔들만 필터
        const posKlines = (klinesBySymbol.get(pos.symbol) ?? [])
          .filter(k => k.openTime >= pos.openedAt.getTime());

        let exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'signalReversal' | 'rsiOverheat' | null = null;
        let exitPrice = price;

        // ── 그리드 추가진입 체크 (RSI 과열 시 그리드 포기 + 즉시 전체 청산) ──
        const gridPrices = Array.isArray(pos.gridPrices) ? (pos.gridPrices as number[]) : [];
        const currentGridsFilled = pos.gridsFilled;

        if (gridPrices.length > 0 && currentGridsFilled < gridPrices.length) {
          let gridsToFill = 0;
          for (let gi = currentGridsFilled; gi < gridPrices.length; gi++) {
            const gp = gridPrices[gi];
            // 현재가 또는 이전 캔들 HIGH가 그리드 가격에 도달했으면 체결
            const reached = price >= gp || posKlines.some(k => k.high >= gp);
            if (reached) gridsToFill++;
            else break;
          }

          if (gridsToFill > 0) {
            // 1100%/500%급 급등처럼 그리드를 계속 태우면 크게 잃는 상황 방지 —
            // 이번 그리드 체결 시점 RSI가 임계값 이상이면 추가진입 포기하고 즉시 전체 청산
            const gridSkipThreshold = strategyGridSkipMap.get(pos.strategyName) ?? null;
            let overheatRsi: number | null = null;
            if (gridSkipThreshold !== null) {
              const rsi14 = await fetchRsi14(pos.symbol, '30m');
              if (rsi14 !== null && rsi14 >= gridSkipThreshold) overheatRsi = rsi14;
            }

            if (overheatRsi !== null) {
              exitReason = 'rsiOverheat';
              exitPrice  = price;
              addLog(userId, `🔥 RSI 과열(${overheatRsi.toFixed(1)}) 감지 ${pos.symbol} — 그리드 포기 + 즉시 전체청산`, 'info');
            } else {
              const freshWallet = await getOrCreateWallet(userId);
              const cost = pos.entryAmountUsdt * gridsToFill;
              if (freshWallet.balance >= cost) {
                let newAvgEntry = pos.avgEntryPrice > 0 ? pos.avgEntryPrice : pos.entryPrice;
                let newTotalUsdt = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;

                for (let i = 0; i < gridsToFill; i++) {
                  const gp = gridPrices[currentGridsFilled + i];
                  newAvgEntry = (newAvgEntry * newTotalUsdt + gp * pos.entryAmountUsdt) / (newTotalUsdt + pos.entryAmountUsdt);
                  newTotalUsdt += pos.entryAmountUsdt;
                }

                const newGridsFilled = currentGridsFilled + gridsToFill;
                await prisma.$transaction([
                  prisma.paperWallet.update({
                    where: { id: freshWallet.id },
                    data:  { balance: freshWallet.balance - cost }
                  }),
                  prisma.paperPosition.update({
                    where: { id: pos.id },
                    data:  { gridsFilled: newGridsFilled, avgEntryPrice: newAvgEntry, totalEntryUsdt: newTotalUsdt }
                  })
                ]);

                addLog(userId,
                  `📈 [그리드] ${pos.symbol} ${newGridsFilled}차 추가진입 | 평균진입가: $${newAvgEntry.toPrecision(5)}`,
                  'signal'
                );
                broadcast({ type: 'paper_grid_fill', data: { symbol: pos.symbol, gridsFilled: newGridsFilled, avgEntryPrice: newAvgEntry } });
              }
            }
          }
        }

        // ── TP / SL / 타임아웃 체크 ──────────────────────────────
        if (!exitReason && Date.now() >= pos.expiresAt.getTime()) {
          exitReason = 'timeout';
        }

        if (!exitReason) {
          if      (price <= pos.takeProfitPrice) { exitReason = 'takeProfit'; exitPrice = pos.takeProfitPrice; }
          else if (price >= pos.stopLossPrice)   { exitReason = 'stopLoss';   exitPrice = pos.stopLossPrice;   }
        }

        // 60초 폴링 사이에 놓친 SL/TP: 캔들 HIGH/LOW로 소급 감지
        if (!exitReason) {
          for (const k of posKlines) {
            if (k.high >= pos.stopLossPrice)   { exitReason = 'stopLoss';   exitPrice = pos.stopLossPrice;   break; }
            if (k.low  <= pos.takeProfitPrice) { exitReason = 'takeProfit'; exitPrice = pos.takeProfitPrice; break; }
          }
        }

        // RSI 반전 신호: 전략의 rsiExitThreshold 미만이면 숏 조기 청산
        const rsiThreshold = strategyThresholdMap.get(pos.strategyName) ?? null;
        if (!exitReason && rsiThreshold !== null) {
          const rsi14 = await fetchRsi14(pos.symbol);
          if (rsi14 !== null && rsi14 < rsiThreshold) {
            exitReason = 'signalReversal';
            exitPrice  = price;
          }
        }

        if (exitReason) {
          const log = await closePaperPosition(userId, pos.id, exitPrice, exitReason as any);
          if (log) {
            const emoji = exitReason === 'takeProfit' ? '✅' : exitReason === 'stopLoss' ? '❌'
              : exitReason === 'signalReversal' ? '🔄' : exitReason === 'rsiOverheat' ? '🔥' : '⏰';
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

  // 2. 활성 전략으로 신호 스캔 → 신규 진입 (위에서 이미 로드됨)
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

export function getRunningUserIds(): string[] {
  return Array.from(scanners.keys());
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
  prisma.user.update({ where: { id: userId }, data: { scannerActive: true } }).catch(() => {});

  addLog(userId, '🚀 가상 스캐너 시작 (1분 간격)', 'info');
  runScanCycle(userId, broadcast).catch(e => addLog(userId, `초기 스캔 오류: ${e.message}`, 'error'));
}

export function stopPaperScanner(userId: string) {
  const state = scanners.get(userId);
  if (!state) return;
  clearInterval(state.interval);
  scanners.delete(userId);
  prisma.user.update({ where: { id: userId }, data: { scannerActive: false } }).catch(() => {});
  console.log(`[Scanner:${userId.slice(0, 6)}] 중지됨`);
}

export async function restoreScanners() {
  try {
    const activeUsers = await prisma.user.findMany({ where: { scannerActive: true }, select: { id: true } });
    if (activeUsers.length === 0) return;
    console.log(`[Scanner] 서버 재시작 후 ${activeUsers.length}개 스캐너 복원 중...`);
    for (const { id } of activeUsers) {
      startPaperScanner(id, () => {});
      console.log(`[Scanner] 복원: ${id.slice(0, 6)}`);
    }
  } catch (e: any) {
    console.error(`[Scanner] 복원 실패: ${e.message}`);
  }
}

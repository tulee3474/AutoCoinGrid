// ── 가상거래 "그리드 체결 전 캔들로 익절 오판" 버그 소급 감사/보정 ──────────────
// autoScanner.ts의 TP/SL 소급 감지 버그(수정: 6cae548)로 인해, 그리드가 1회 체결된 뒤 익절로
// 종료된 과거 거래 중 일부는 실제로는 그 시점에 도달하지 않았던 익절가를 그리드 체결 "전" 캔들의
// 저가/고가와 잘못 비교해 익절로 기록됐을 수 있음. 이 함수는 그런 과거 기록을 실제 바이낸스 과거
// 캔들로 재검증해서 "가짜 익절"이었던 거래를 찾아 통계에서 제거한다(원인 코드는 이미 수정됐으므로
// 앞으로의 신규 거래는 영향 없음 — 이건 이미 종료된 과거 기록만을 위한 1회성 감사).
//
// 그리드가 2회 이상 체결된 거래는 최종 평균단가만으로는 각 레벨의 정확한 체결가를 역산할 수 없어
// (여러 가격 조합이 같은 평균에 도달 가능) 검증 대상에서 제외한다 — 잘못 건드리는 것보다 안전.

import prisma from '../lib/prisma';
import { binance } from './binance';
import { Side } from '../types';

interface AuditResult {
  checked: number;
  skippedAmbiguous: number;
  confirmedLegit: number;
  fixedPhantom: number;
  errors: number;
  details: string[];
}

// 그리드 1회 체결 시 최종(조화)평균단가 = 2 / (1/entryPrice + 1/gridPrice) → gridPrice로 역산
function reconstructGridPrice(entryPrice: number, avgEntryPrice: number): number | null {
  const sumInv = 2 / avgEntryPrice - 1 / entryPrice;
  if (sumInv <= 0) return null;
  const gridPrice = 1 / sumInv;
  return Number.isFinite(gridPrice) && gridPrice > 0 ? gridPrice : null;
}

export async function auditPhantomTakeProfits(): Promise<AuditResult> {
  const result: AuditResult = { checked: 0, skippedAmbiguous: 0, confirmedLegit: 0, fixedPhantom: 0, errors: 0, details: [] };

  // 그리드 1회 체결 + 익절로 종료된 과거 거래만 대상 (그 외는 이 버그와 무관하거나 검증 불가)
  const candidates = await prisma.paperTradeLog.findMany({
    where: { exitReason: 'takeProfit', gridsFilled: 1 },
    orderBy: { exitTime: 'asc' }
  });

  for (const log of candidates) {
    result.checked++;
    try {
      const side = (log.side as Side) ?? 'SHORT';
      const avgEntry = log.avgEntryPrice > 0 ? log.avgEntryPrice : log.entryPrice;

      const gridPrice = reconstructGridPrice(log.entryPrice, avgEntry);
      // 역산된 그리드가가 방향과 안 맞으면(숏인데 진입가보다 낮다든가) 데이터 이상 — 건드리지 않음
      const gridDirectionOk = gridPrice !== null && (side === 'SHORT' ? gridPrice > log.entryPrice : gridPrice < log.entryPrice);
      if (!gridDirectionOk) {
        result.skippedAmbiguous++;
        continue;
      }

      const klines = await binance.getFuturesKlinesSince(log.symbol, '1h', log.entryTime.getTime());
      const windowKlines = klines.filter(k => k.openTime <= log.exitTime.getTime());

      const triggerCandle = windowKlines.find(k =>
        side === 'SHORT' ? k.high >= gridPrice! : k.low <= gridPrice!
      );
      if (!triggerCandle) {
        // 캔들 데이터로 그리드 체결 시점을 못 찾음(데이터 유효기간 초과 등) — 검증 불가, 건드리지 않음
        result.skippedAmbiguous++;
        continue;
      }

      // 그리드 체결 "이후" 캔들 중 실제로 기록된 익절가(log.exitPrice)에 도달한 적이 있는지 재검증
      const postGridKlines = windowKlines.filter(k => k.openTime >= triggerCandle.closeTime);
      const legitimateHit = postGridKlines.some(k =>
        side === 'SHORT' ? k.low <= log.exitPrice : k.high >= log.exitPrice
      );

      if (legitimateHit) {
        result.confirmedLegit++;
        continue;
      }

      // 가짜 익절로 확정 — 거래 기록 삭제 + 지갑 잔고에서 해당 손익만큼 회수(원금 반환은 그대로 둠)
      await prisma.$transaction(async tx => {
        const wallet = await tx.paperWallet.findUnique({ where: { id: log.walletId } });
        if (!wallet) return;
        await tx.paperWallet.update({
          where: { id: wallet.id },
          data:  { balance: Math.max(0, wallet.balance - log.pnlUsdt) }
        });
        await tx.paperTradeLog.delete({ where: { id: log.id } });
      });

      result.fixedPhantom++;
      result.details.push(
        `[보정] ${log.symbol} (${side}) 진입 ${log.entryTime.toISOString()} — 기록된 익절가 $${log.exitPrice}는 ` +
        `그리드 체결(약 $${gridPrice!.toPrecision(5)}, ${triggerCandle.closeTime}) 이후 실제로 도달한 적 없음 → ` +
        `가짜 익절 기록 삭제, 지갑 잔고 $${log.pnlUsdt.toFixed(2)} 회수`
      );
    } catch (e: any) {
      result.errors++;
      result.details.push(`[오류] ${log.symbol} (${log.id}): ${e.message}`);
    }
  }

  return result;
}

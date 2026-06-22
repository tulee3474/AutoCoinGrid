import { TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { calcPdfStopLoss } from './gridUtils';

export async function getOrCreateWallet(userId: string) {
  return prisma.paperWallet.upsert({
    where:  { userId },
    create: { userId },
    update: {},
    include: {
      openPositions: true,
      tradeLogs: { orderBy: { exitTime: 'desc' }, take: 500 }
    }
  });
}

export async function openPaperPosition(
  userId: string,
  symbol: string,
  entryPrice: number,
  trade: TradeConfig,
  strategyName: string
) {
  const wallet = await getOrCreateWallet(userId);

  if (wallet.openPositions.find(p => p.symbol === symbol)) return null;
  if (wallet.balance < trade.entryAmountUsdt) return null;

  const takeProfitPrice = entryPrice * (1 - trade.takeProfitPct / 100);
  // SL = PDF 방식: 전체 그리드 체결 후 조화평균 진입가에서 한 단계 더
  const stopLossPrice = calcPdfStopLoss(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing);
  // maxDurationHours: null = 타임아웃 없음 → 1년 후로 설정
  const expiresAt = trade.maxDurationHours != null
    ? new Date(Date.now() + trade.maxDurationHours * 3_600_000)
    : new Date(Date.now() + 365 * 24 * 3_600_000);

  const [, position] = await prisma.$transaction([
    prisma.paperWallet.update({
      where: { id: wallet.id },
      data:  { balance: wallet.balance - trade.entryAmountUsdt }
    }),
    prisma.paperPosition.create({
      data: {
        walletId: wallet.id,
        symbol,
        entryPrice,
        takeProfitPrice,
        stopLossPrice,
        entryAmountUsdt: trade.entryAmountUsdt,
        leverage: trade.leverage,
        expiresAt,
        strategyName
      }
    })
  ]);

  return position;
}

export async function closePaperPosition(
  userId: string,
  positionId: string,
  exitPrice: number,
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual' | 'signalReversal'
) {
  const wallet = await getOrCreateWallet(userId);
  const pos    = wallet.openPositions.find(p => p.id === positionId);
  if (!pos) return null;

  // SHORT: 가격이 내려가면 수익
  const pnlPct  = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100 * pos.leverage;
  const pnlUsdt = pos.entryAmountUsdt * pnlPct / 100;
  const newBalance = Math.max(0, wallet.balance + pos.entryAmountUsdt + pnlUsdt);

  const [, log] = await prisma.$transaction([
    prisma.paperWallet.update({
      where: { id: wallet.id },
      data:  { balance: newBalance }
    }),
    prisma.paperTradeLog.create({
      data: {
        walletId:        wallet.id,
        symbol:          pos.symbol,
        entryTime:       pos.openedAt,
        exitTime:        new Date(),
        entryPrice:      pos.entryPrice,
        exitPrice,
        pnlPct,
        pnlUsdt,
        exitReason,
        entryAmountUsdt: pos.entryAmountUsdt,
        leverage:        pos.leverage,
        strategyName:    pos.strategyName
      }
    }),
    prisma.paperPosition.delete({ where: { id: pos.id } })
  ]);

  return log;
}

export async function resetPaperWallet(userId: string) {
  const wallet = await getOrCreateWallet(userId);
  await prisma.$transaction([
    prisma.paperPosition.deleteMany({ where: { walletId: wallet.id } }),
    prisma.paperTradeLog.deleteMany({ where: { walletId: wallet.id } }),
    prisma.paperWallet.update({
      where: { id: wallet.id },
      data:  { balance: 10_000, initialBalance: 10_000 }
    })
  ]);
}

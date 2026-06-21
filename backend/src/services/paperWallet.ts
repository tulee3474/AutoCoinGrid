import { TradeConfig } from '../types';
import prisma from '../lib/prisma';

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
  // SL = 마지막 그리드 레벨 위 한 단계 (백테스트와 동일 로직)
  const gridTopPrice  = entryPrice * (1 + (trade.gridSpacing / 100) * trade.gridLevels);
  const stopLossPrice = gridTopPrice * (1 + trade.gridSpacing / 100);
  const expiresAt       = new Date(Date.now() + trade.maxDurationHours * 3_600_000);

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
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual'
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

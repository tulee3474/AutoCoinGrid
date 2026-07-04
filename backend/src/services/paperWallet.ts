import { TradeConfig } from '../types';
import prisma from '../lib/prisma';
import { calcPdfStopLoss, calcPdfGridPrices } from './gridUtils';

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

  if (trade.reEntryCooldownHours) {
    const lastLog = await prisma.paperTradeLog.findFirst({
      where:   { walletId: wallet.id, symbol },
      orderBy: { exitTime: 'desc' }
    });
    if (lastLog && Date.now() - lastLog.exitTime.getTime() < trade.reEntryCooldownHours * 3_600_000) {
      return null;
    }
  }

  const gridEnabled = trade.gridEnabled !== false;
  const takeProfitPrice = entryPrice * (1 - trade.takeProfitPct / 100);
  const stopLossPrice = gridEnabled
    ? calcPdfStopLoss(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing)
    : entryPrice * (1 + trade.stopLossPct / 100);
  const gridPrices = gridEnabled
    ? calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing)
    : [];
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
        walletId:        wallet.id,
        symbol,
        entryPrice,
        avgEntryPrice:   entryPrice,
        totalEntryUsdt:  trade.entryAmountUsdt,
        gridsFilled:     0,
        gridPrices:      gridPrices as any,
        takeProfitPrice,
        stopLossPrice,
        entryAmountUsdt: trade.entryAmountUsdt,
        leverage:        trade.leverage,
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
  exitReason: 'takeProfit' | 'stopLoss' | 'timeout' | 'manual' | 'signalReversal' | 'rsiOverheat'
) {
  const wallet = await getOrCreateWallet(userId);
  const pos    = wallet.openPositions.find(p => p.id === positionId);
  if (!pos) return null;

  // 그리드 추가진입이 있으면 avgEntryPrice 기준으로 PnL 계산
  const avgEntry   = pos.avgEntryPrice > 0 ? pos.avgEntryPrice : pos.entryPrice;
  const totalUsdt  = pos.totalEntryUsdt > 0 ? pos.totalEntryUsdt : pos.entryAmountUsdt;

  // SHORT: 가격이 내려가면 수익
  const pnlPct  = ((avgEntry - exitPrice) / avgEntry) * 100 * pos.leverage;
  const pnlUsdt = totalUsdt * pnlPct / 100;
  const newBalance = Math.max(0, wallet.balance + totalUsdt + pnlUsdt);

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
        avgEntryPrice:   avgEntry,
        exitPrice,
        pnlPct,
        pnlUsdt,
        exitReason,
        entryAmountUsdt: pos.entryAmountUsdt,
        totalEntryUsdt:  totalUsdt,
        gridsFilled:     pos.gridsFilled,
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

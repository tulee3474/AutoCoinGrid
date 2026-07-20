import { TradeConfig, Side } from '../types';
import prisma from '../lib/prisma';
import { calcPdfStopLoss, calcPdfGridPrices, calcTakeProfitPrice, calcSimpleStopLoss, capSlWithLiquidation, truncateGridsToSafeZone, resolveReEntryCooldownHours, dirSign } from './gridUtils';
import { estimateLiquidationPrice } from './binance';

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
  strategyName: string,
  side: Side = 'SHORT'
) {
  const wallet = await getOrCreateWallet(userId);

  // 같은 심볼이라도 방향(side)이 다르면 롱/숏 동시 보유 허용 (가상거래는 시뮬레이션이라
  // 실거래 헤지모드 제약이 없음)
  if (wallet.openPositions.find(p => p.symbol === symbol && p.side === side)) return null;
  if (wallet.balance < trade.entryAmountUsdt) return null;

  if (trade.blockLossSymbols) {
    const anyLoss = await prisma.paperTradeLog.findFirst({ where: { walletId: wallet.id, symbol, pnlUsdt: { lte: 0 } } });
    if (anyLoss) return null;
  }

  const lastLog = await prisma.paperTradeLog.findFirst({
    where:   { walletId: wallet.id, symbol },
    orderBy: { exitTime: 'desc' }
  });
  if (lastLog) {
    const cooldownHours = resolveReEntryCooldownHours(trade, lastLog.pnlUsdt > 0);
    if (cooldownHours && Date.now() - lastLog.exitTime.getTime() < cooldownHours * 3_600_000) {
      return null;
    }
  }

  const gridEnabled = trade.gridEnabled !== false;
  const takeProfitPrice = calcTakeProfitPrice(entryPrice, trade.takeProfitPct, side);
  const safetyPct = trade.liquidationSafetyPct ?? 99;

  let gridPrices = gridEnabled
    ? calcPdfGridPrices(entryPrice, trade.leverage, trade.gridLevels, trade.gridSpacing, side)
    : [];
  let stopLossPrice: number;
  if (gridEnabled) {
    // 실거래 계좌 포지션이 없어 실시간 청산가를 못 받으므로, 유지증거금률 구간표로 추정
    // (조회 실패 시 0 반환 → truncate/cap 모두 no-op, 기존 방식과 동일하게 동작)
    const qty = trade.entryAmountUsdt * trade.leverage / entryPrice;
    const liqPrice = (await estimateLiquidationPrice(symbol, trade.entryAmountUsdt, qty, entryPrice, side)) ?? 0;
    gridPrices = truncateGridsToSafeZone(gridPrices, entryPrice, liqPrice, safetyPct, side);
    stopLossPrice = calcPdfStopLoss(entryPrice, trade.leverage, gridPrices.length, trade.gridSpacing, side);
    stopLossPrice = capSlWithLiquidation(stopLossPrice, entryPrice, liqPrice, safetyPct, side);
  } else {
    stopLossPrice = calcSimpleStopLoss(entryPrice, trade.stopLossPct, side);
  }
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
        side,
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
  const side       = (pos.side as Side) ?? 'SHORT';

  // 숏: 가격이 내려가면 수익 / 롱: 가격이 오르면 수익
  const pnlPct  = ((avgEntry - exitPrice) / avgEntry) * 100 * pos.leverage * dirSign(side);
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
        side,
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

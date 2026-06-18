import { Router } from 'express';
import { binance } from '../services/binance';

const router = Router();

// GET /api/trading/positions - 오픈 포지션
router.get('/positions', async (_req, res) => {
  try {
    const positions = await binance.getPositions();
    res.json(positions.map((p: any) => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) < 0 ? 'SHORT' : 'LONG',
      positionAmt: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedProfit: parseFloat(p.unRealizedProfit),
      leverage: parseInt(p.leverage),
      liquidationPrice: parseFloat(p.liquidationPrice),
      marginType: p.marginType,
      notional: Math.abs(parseFloat(p.notional))
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/trading/orders - 오픈 주문
router.get('/orders', async (req, res) => {
  try {
    const symbol = req.query.symbol as string | undefined;
    const orders = await binance.getOpenOrders(symbol);
    res.json(orders);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/trading/short - 그리드 숏 진입
router.post('/short', async (req, res) => {
  const { symbol, leverage, entryAmountUsdt, gridLevels, gridSpacing, takeProfitPct, stopLossPct } = req.body;
  if (!symbol || !leverage || !entryAmountUsdt) {
    return res.status(400).json({ error: 'symbol, leverage, entryAmountUsdt 필요' });
  }

  try {
    // 마진 타입 설정
    await binance.setMarginType(symbol, 'ISOLATED');
    await binance.setLeverage(symbol, leverage);

    // 현재가 조회
    const tickers = await binance.get24hrTickers();
    const ticker = tickers.find((t: any) => t.symbol === symbol);
    if (!ticker) return res.status(400).json({ error: '심볼을 찾을 수 없음' });
    const currentPrice = parseFloat(ticker.lastPrice);

    // 최소 주문 단위 조회
    const info = await binance.getFuturesExchangeInfo();
    const symbolInfo = info.symbols.find((s: any) => s.symbol === symbol);
    const qtyPrecision = symbolInfo?.quantityPrecision ?? 2;

    const results = [];

    // 1. 초기 시장가 진입
    const initQty = parseFloat(
      (entryAmountUsdt / currentPrice).toFixed(qtyPrecision)
    );
    const initOrder = await binance.placeOrder({
      symbol, side: 'SELL', type: 'MARKET', quantity: initQty.toString()
    });
    results.push({ level: 0, type: 'MARKET', order: initOrder });

    // 2. 그리드 지정가 주문 (현재가 위로 gridSpacing% 간격)
    for (let i = 1; i <= (gridLevels ?? 5); i++) {
      const gridPrice = currentPrice * (1 + (gridSpacing ?? 10) / 100 * i);
      const gridQty = parseFloat(
        (entryAmountUsdt / gridPrice).toFixed(qtyPrecision)
      );
      const gridOrder = await binance.placeOrder({
        symbol, side: 'SELL', type: 'LIMIT',
        quantity: gridQty.toString(),
        price: gridPrice.toFixed(symbolInfo?.pricePrecision ?? 2)
      });
      results.push({ level: i, type: 'LIMIT', price: gridPrice, order: gridOrder });
    }

    // 3. TP/SL (마켓 진입가 기준)
    if (takeProfitPct) {
      const tpPrice = currentPrice * (1 - takeProfitPct / 100);
      await binance.placeOrder({
        symbol, side: 'BUY', type: 'TAKE_PROFIT_MARKET',
        quantity: (initQty * ((gridLevels ?? 5) + 1)).toString(),
        stopPrice: tpPrice.toFixed(symbolInfo?.pricePrecision ?? 2),
        reduceOnly: true
      });
    }

    res.json({ success: true, orders: results });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/trading/position/:symbol - 포지션 청산
router.delete('/position/:symbol', async (req, res) => {
  const { symbol } = req.params;
  try {
    await binance.cancelAllOrders(symbol);
    const positions = await binance.getPositions();
    const pos = positions.find((p: any) => p.symbol === symbol);
    if (!pos) return res.json({ ok: true, message: '포지션 없음' });

    const closeQty = Math.abs(parseFloat(pos.positionAmt)).toString();
    const closeSide = parseFloat(pos.positionAmt) < 0 ? 'BUY' : 'SELL';
    await binance.placeOrder({
      symbol, side: closeSide, type: 'MARKET',
      quantity: closeQty, reduceOnly: true
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/trading/account - 계좌 정보
router.get('/account', async (_req, res) => {
  try {
    const account = await binance.getAccountInfo();
    res.json({
      totalWalletBalance: parseFloat(account.totalWalletBalance),
      availableBalance: parseFloat(account.availableBalance),
      totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit),
      totalMarginBalance: parseFloat(account.totalMarginBalance)
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;

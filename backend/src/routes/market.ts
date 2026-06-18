import { Router } from 'express';
import { binance } from '../services/binance';
import { computeIndicators } from '../services/indicator';
import { scanMarket } from '../services/scanner';
import { StrategyConditions } from '../types';

const router = Router();

// GET /api/market/tickers - 24h 상승률 상위 USDT 페어
router.get('/tickers', async (_req, res) => {
  try {
    const tickers = await binance.get24hrTickers();
    const filtered = tickers
      .filter((t: any) =>
        t.symbol.endsWith('USDT') &&
        !['BTCUSDT', 'ETHUSDT'].includes(t.symbol)
      )
      .map((t: any) => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
        high24h: parseFloat(t.highPrice),
        low24h: parseFloat(t.lowPrice)
      }))
      .sort((a: any, b: any) => b.change24h - a.change24h)
      .slice(0, 50);
    res.json(filtered);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/klines/:symbol - 캔들 데이터
router.get('/klines/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const interval = (req.query.interval as string) || '1h';
  const limit = parseInt(req.query.limit as string) || 200;
  try {
    const klines = await binance.getKlines(symbol, interval, limit);
    res.json(klines);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/indicators/:symbol - 지표 계산
router.get('/indicators/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const interval = (req.query.interval as string) || '1h';
  try {
    const klines = await binance.getKlines(symbol, interval, 250);
    const ind = computeIndicators(klines, interval);
    const ticker = (await binance.get24hrTickers()).find((t: any) => t.symbol === symbol);
    res.json({
      symbol,
      ...ind,
      change24h: ticker ? parseFloat(ticker.priceChangePercent) : 0,
      volume24h: ticker ? parseFloat(ticker.quoteVolume) : 0
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/market/scan - 전략 조건으로 코인 스캔
router.post('/scan', async (req, res) => {
  try {
    const conditions: StrategyConditions = req.body.conditions;
    const btcDominance: number = req.body.btcDominance ?? 50;
    if (!conditions) return res.status(400).json({ error: 'conditions 필요' });
    const results = await scanMarket(conditions, btcDominance);
    res.json(results);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/market/dominance - BTC 도미넌스 (CoinGecko 공개 API 사용)
router.get('/dominance', async (_req, res) => {
  try {
    const { data } = await (await import('axios')).default.get(
      'https://api.coingecko.com/api/v3/global',
      { timeout: 8000 }
    );
    const dominance = data.data?.market_cap_percentage?.btc ?? 0;
    res.json({ dominance: parseFloat(dominance.toFixed(2)) });
  } catch {
    // CoinGecko 실패시 Binance 볼륨 비율로 대체 (상위 USDT 페어만)
    try {
      const tickers = await binance.get24hrTickers();
      const majorUsdt = tickers.filter((t: any) =>
        ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
         'ADAUSDT','DOGEUSDT','AVAXUSDT','DOTUSDT','MATICUSDT'].includes(t.symbol)
      );
      const totalVol = majorUsdt.reduce((s: number, t: any) => s + parseFloat(t.quoteVolume || 0), 0);
      const btcVol = majorUsdt.find((t: any) => t.symbol === 'BTCUSDT');
      const dominance = btcVol && totalVol > 0
        ? (parseFloat(btcVol.quoteVolume) / totalVol) * 100
        : 50;
      res.json({ dominance: parseFloat(dominance.toFixed(2)), source: 'volume-approx' });
    } catch (e: any) {
      res.json({ dominance: 50, source: 'fallback' });
    }
  }
});

export default router;

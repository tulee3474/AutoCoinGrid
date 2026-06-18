import { Router } from 'express';
import { getDataInfo, saveCSV, deleteCSV, fetchFromCoinGecko, CSV_PATH } from '../services/btcDominanceHistory';
import { existsSync, readFileSync } from 'fs';

const router = Router();

// GET /api/data/btc-dominance - 현재 데이터 현황
router.get('/btc-dominance', (_req, res) => {
  const info = getDataInfo();
  res.json(info);
});

// GET /api/data/btc-dominance/raw - CSV 원본 반환
router.get('/btc-dominance/raw', (_req, res) => {
  if (!existsSync(CSV_PATH)) return res.json({ content: '' });
  res.json({ content: readFileSync(CSV_PATH, 'utf-8') });
});

// POST /api/data/btc-dominance - CSV 업로드 (body: { csv: string })
router.post('/btc-dominance', (req, res) => {
  const { csv } = req.body;
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv 필드 필요 (문자열)' });
  }
  const result = saveCSV(csv);
  res.json({ ...result, info: getDataInfo() });
});

// POST /api/data/btc-dominance/fetch - CoinGecko에서 자동 수집
// ?days=365 (기본값 365, 최대 730)
router.post('/btc-dominance/fetch', async (req, res) => {
  const days = Math.min(parseInt(req.query.days as string) || 365, 730);
  try {
    const result = await fetchFromCoinGecko(days);
    if (result.error) {
      return res.status(502).json({ error: result.error });
    }
    res.json({ ...result, info: getDataInfo() });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/data/btc-dominance - 데이터 삭제
router.delete('/btc-dominance', (_req, res) => {
  deleteCSV();
  res.json({ ok: true });
});

export default router;

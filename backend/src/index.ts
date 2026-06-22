import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import marketRoutes from './routes/market';
import strategyRoutes from './routes/strategy';
import backtestRoutes from './routes/backtest';
import paperRoutes, { setPaperBroadcast } from './routes/paper';
import dataRoutes from './routes/data';
import liveRoutes, { setLiveBroadcast } from './routes/live';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import presetRoutes from './routes/presets';
import { fetchFromCoinGecko } from './services/btcDominanceHistory';
import { restoreScanners } from './services/autoScanner';
import { restoreLiveScanners } from './services/liveTrader';

const app = express();
app.set('trust proxy', 1); // Docker/nginx 뒤에서 X-Forwarded-For 신뢰
const PORT = process.env.PORT || 3001;

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:80', 'http://localhost'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.use('/api', rateLimit({ windowMs: 60_000, max: 120, message: 'Too many requests' }));

app.use('/api/market', marketRoutes);
app.use('/api/strategy', strategyRoutes);
app.use('/api/backtest', backtestRoutes);
app.use('/api/paper', paperRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/presets', presetRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

export const broadcast = (data: unknown) => {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
};

wss.on('connection', (ws) => {
  console.log('WS client connected');
  ws.on('close', () => console.log('WS client disconnected'));
  ws.send(JSON.stringify({ type: 'connected', message: 'AutoCoin WebSocket 연결됨' }));
});

// ── BTC 도미넌스 매일 새벽 4시 자동 업데이트 ─────────────────────
function scheduleDailyDomUpdate() {
  const now  = new Date();
  const next = new Date();
  next.setHours(4, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();
  const h = Math.floor(delay / 3_600_000);
  const m = Math.floor((delay % 3_600_000) / 60_000);
  console.log(`[Cron] BTC 도미넌스 다음 업데이트: ${h}시간 ${m}분 후 (매일 04:00 KST)`);

  setTimeout(async () => {
    console.log('[Cron] BTC 도미넌스 자동 업데이트 시작...');
    const result = await fetchFromCoinGecko(7).catch(e => ({ saved: 0, dateRange: null, error: String(e) }));
    if (result.error) console.error(`[Cron] 업데이트 실패: ${result.error}`);
    else console.log(`[Cron] 업데이트 완료: ${result.saved}개 저장 (${result.dateRange})`);
    scheduleDailyDomUpdate();
  }, delay);
}

server.listen(PORT, () => {
  console.log(`AutoCoin backend running on http://localhost:${PORT}`);
  setPaperBroadcast(broadcast);
  setLiveBroadcast(broadcast);
  scheduleDailyDomUpdate();
  restoreScanners();
  restoreLiveScanners(broadcast);
});

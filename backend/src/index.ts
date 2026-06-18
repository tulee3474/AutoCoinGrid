import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import marketRoutes from './routes/market';
import strategyRoutes from './routes/strategy';
import backtestRoutes from './routes/backtest';
import tradingRoutes from './routes/trading';
import paperRoutes, { setPaperBroadcast } from './routes/paper';
import dataRoutes from './routes/data';
import liveRoutes, { setLiveBroadcast } from './routes/live';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import { binance } from './services/binance';

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:5173', 'http://localhost:80', 'http://localhost'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// API rate limit (Binance 제한 보호)
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, message: 'Too many requests' }));

// 라우트
app.use('/api/market', marketRoutes);
app.use('/api/strategy', strategyRoutes);
app.use('/api/backtest', backtestRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/paper', paperRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: Date.now() }));

// ── WebSocket: 실시간 포지션/가격 스트림 ────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = (data: unknown) => {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
};

// 5초마다 포지션 업데이트 브로드캐스트
let positionInterval: NodeJS.Timeout | null = null;

wss.on('connection', (ws) => {
  console.log('WS client connected');

  if (wss.clients.size === 1) {
    // 첫 클라이언트 연결시 폴링 시작
    positionInterval = setInterval(async () => {
      try {
        if (process.env.BINANCE_API_KEY) {
          const positions = await binance.getPositions();
          broadcast({ type: 'positions', data: positions });
        }
      } catch { /* ignore */ }
    }, 5000);
  }

  ws.on('close', () => {
    console.log('WS client disconnected');
    if (wss.clients.size === 0 && positionInterval) {
      clearInterval(positionInterval);
      positionInterval = null;
    }
  });

  ws.send(JSON.stringify({ type: 'connected', message: 'AutoCoin WebSocket 연결됨' }));
});

server.listen(PORT, () => {
  console.log(`AutoCoin backend running on http://localhost:${PORT}`);
  if (!process.env.BINANCE_API_KEY) {
    console.warn('⚠️  BINANCE_API_KEY 미설정 — 퍼블릭 API만 사용 가능');
  }

  // 스캐너는 사용자별 수동 시작 (POST /api/paper/scanner/start, POST /api/live/start)
  setPaperBroadcast(broadcast);
  setLiveBroadcast(broadcast);
});

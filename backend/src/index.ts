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

const app = express();
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

server.listen(PORT, () => {
  console.log(`AutoCoin backend running on http://localhost:${PORT}`);
  setPaperBroadcast(broadcast);
  setLiveBroadcast(broadcast);
});

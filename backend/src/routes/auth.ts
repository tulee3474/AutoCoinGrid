import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { encrypt, decrypt } from '../lib/crypto';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

function signToken(userId: string, email: string): string {
  const secret = process.env.JWT_SECRET!;
  return jwt.sign({ userId, email }, secret, { expiresIn: '7d' });
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email과 password가 필요합니다' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }

  try {
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: '이미 사용 중인 이메일입니다' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash }
    });

    // 가상 지갑 자동 생성
    await prisma.paperWallet.create({
      data: { userId: user.id }
    });

    const token = signToken(user.id, user.email);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email과 password가 필요합니다' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸습니다' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: '이메일 또는 비밀번호가 틀렸습니다' });

    const token = signToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email, hasApiKeys: !!(user.apiKey && user.apiSecret) } });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: '사용자 없음' });
    res.json({ id: user.id, email: user.email, hasApiKeys: !!(user.apiKey && user.apiSecret) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/auth/api-keys  (Binance API 키 등록/수정)
router.put('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ error: 'apiKey와 apiSecret이 필요합니다' });
  }

  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        apiKey:    encrypt(apiKey),
        apiSecret: encrypt(apiSecret)
      }
    });
    res.json({ ok: true, message: 'API 키가 저장되었습니다' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/auth/api-keys
router.delete('/api-keys', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { apiKey: null, apiSecret: null }
    });
    res.json({ ok: true, message: 'API 키가 삭제되었습니다' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/crypto-check — 암호화 키 진단 (로그인 필요)
router.get('/crypto-check', requireAuth, async (req: AuthRequest, res: Response) => {
  const key = process.env.ENCRYPTION_KEY ?? '';
  const keyLen = key.length;
  const keyPrefix = key.slice(0, 4).replace(/./g, '*') + '...'; // 절대 노출 안 함

  // 1. 기본 암/복호화 사이클 테스트
  let cycleOk = false;
  let cycleError = '';
  try {
    const enc = encrypt('__test__');
    const dec = decrypt(enc);
    cycleOk = dec === '__test__';
  } catch (e: any) {
    cycleError = e.message;
  }

  // 2. DB에 저장된 암호화 키 포맷 확인 (값 자체는 노출 안 함)
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  const storedKey = user?.apiKey ?? null;
  let storedFormat = 'none';
  let decryptOk = false;
  let decryptError = '';
  if (storedKey) {
    const parts = storedKey.split(':');
    storedFormat = parts.length === 3
      ? `ok (iv=${parts[0].length}chars tag=${parts[1].length}chars enc=${parts[2].length}chars)`
      : `bad format (${parts.length} parts)`;
    try {
      decrypt(storedKey);
      decryptOk = true;
    } catch (e: any) {
      decryptError = e.message;
    }
  }

  res.json({
    encryptionKeyLength: keyLen,
    encryptionKeyValid: keyLen >= 32,
    cycleOk,
    cycleError: cycleError || null,
    storedFormat,
    decryptOk,
    decryptError: decryptError || null,
  });
});

// 내부 헬퍼: userId로 복호화된 API 키 반환 (다른 서비스에서 사용)
export async function getUserApiKeys(userId: string): Promise<{ apiKey: string; apiSecret: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.apiKey || !user?.apiSecret) return null;
  return {
    apiKey:    decrypt(user.apiKey),
    apiSecret: decrypt(user.apiSecret)
  };
}

export default router;

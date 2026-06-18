import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '관리자 인증이 필요합니다' });
  }

  const token = header.slice(7);
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: 'JWT_SECRET 미설정' });

  try {
    const payload = jwt.verify(token, secret) as { role: string };
    if (payload.role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한 없음' });
    }
    next();
  } catch {
    return res.status(401).json({ error: '관리자 토큰이 유효하지 않습니다' });
  }
}

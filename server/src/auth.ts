import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { cfg } from './config.js';

export interface AuthUser { uid: string; tid: string; role: 'owner' | 'clerk' | 'readonly'; name: string; email: string }
declare global { namespace Express { interface Request { user: AuthUser } } }

export const signToken = (u: AuthUser) => jwt.sign(u, cfg.jwtSecret, { expiresIn: '12h' });

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  try { req.user = jwt.verify(token, cfg.jwtSecret) as AuthUser; if (!req.user?.tid || !req.user.uid) throw new Error('bad token'); next(); }
  catch { res.status(401).json({ error: 'Not signed in' }); }
}

/** Read-only users cannot change anything; only owners can change policy and autonomy. */
export function writeGuard(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET') return next();
  if (req.user.role === 'readonly') return res.status(403).json({ error: 'Your role is read-only' });
  if (req.user.role !== 'owner' && /^\/(policy|google)/.test(req.path)) return res.status(403).json({ error: 'Only the owner can change this' });
  next();
}

export type Req = Request<Record<string, string>>;
export const h = (fn: (req: Req, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
  fn(req as Req, res).catch((e) => {
    const msg = String(e?.message ?? e);
    const code = e?.code === 'P2025' || /No .* found/.test(msg) ? 404 : e?.name === 'ZodError' ? 400 : 500;
    if (code === 500) console.error(`[api] ${req.method} ${req.path}:`, e);
    res.status(code).json({ error: e?.name === 'ZodError' ? 'Invalid input' : code === 404 ? 'Not found' : msg.slice(0, 300), details: e?.name === 'ZodError' ? e.issues : undefined });
  });
};

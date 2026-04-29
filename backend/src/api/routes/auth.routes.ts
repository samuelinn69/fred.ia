import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authService } from '../../services/auth.service';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.middleware';

export const authRoutes = Router();

// ── Validation schemas ────────────────────────────────────────
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128)
    .regex(/[A-Z]/, 'Must contain uppercase')
    .regex(/[0-9]/, 'Must contain a number'),
  name: z.string().min(2).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

// ── POST /api/auth/register ───────────────────────────────────
authRoutes.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = registerSchema.parse(req.body);
    const { user, tokens } = await authService.register(input);
    res.status(201).json({ user, tokens });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
authRoutes.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = loginSchema.parse(req.body);
    const { user, tokens } = await authService.login(input);
    res.json({ user, tokens });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
authRoutes.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await authService.refreshTokens(refreshToken);
    res.json({ tokens });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
authRoutes.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    await authService.logout(refreshToken);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
authRoutes.get('/me', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  res.json({ user: authReq.user });
});

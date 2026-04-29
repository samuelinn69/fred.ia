import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { db } from '../config/database';
import { UnauthorizedError, InsufficientCreditsError } from './errorHandler';
import { logger } from '../utils/logger';

// ── Extended Request type ────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    credits: number;
    subscriptionTier: string;
  };
}

// ── JWT Payload type ─────────────────────────────────────────
interface JwtPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

// ── Auth Middleware ──────────────────────────────────────────
export const authenticate = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, config.auth.jwtSecret) as JwtPayload;
    } catch (err) {
      const isExpired = (err as Error).name === 'TokenExpiredError';
      throw new UnauthorizedError(isExpired ? 'Token expired' : 'Invalid token');
    }

    // Fetch fresh user data (ensures revoked tokens are rejected)
    const user = await db.queryOne<{
      id: string;
      email: string;
      credits: number;
      subscription_tier: string;
      is_active: boolean;
    }>(
      'SELECT id, email, credits, subscription_tier, is_active FROM users WHERE id = $1',
      [payload.sub]
    );

    if (!user || !user.is_active) {
      throw new UnauthorizedError('Account not found or deactivated');
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      email: user.email,
      credits: user.credits,
      subscriptionTier: user.subscription_tier,
    };

    next();
  } catch (err) {
    next(err);
  }
};

// ── Credit Guard Middleware ──────────────────────────────────
// Use AFTER authenticate. Checks if user has >= minCredits before proceeding.
export const requireCredits = (minCredits = 1) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    const { credits, subscriptionTier } = authReq.user;

    // Enterprise / unlimited tier bypasses credit checks
    if (subscriptionTier === 'enterprise') {
      return next();
    }

    if (credits < minCredits) {
      logger.warn('Credit check failed', {
        userId: authReq.user.id,
        required: minCredits,
        available: credits,
      });
      return next(new InsufficientCreditsError(minCredits, credits));
    }

    next();
  };

// ── Deduct Credits (call after AI response) ──────────────────
export const deductCredits = async (
  userId: string,
  tokensUsed: number
): Promise<number> => {
  const creditsToDeduct = Math.ceil(tokensUsed / 1000) * config.credits.per1kTokens;

  const result = await db.queryOne<{ credits: number }>(
    `UPDATE users
     SET credits = GREATEST(0, credits - $1),
         total_tokens_used = total_tokens_used + $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING credits`,
    [creditsToDeduct, tokensUsed, userId]
  );

  return result?.credits ?? 0;
};

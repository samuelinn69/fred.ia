import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/database';
import { config } from '../config/env';
import { AppError, UnauthorizedError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────
export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  credits: number;
  subscriptionTier: string;
  createdAt: string;
}

const SALT_ROUNDS = 12;
const ACCESS_TOKEN_TTL = 15 * 60;          // 15 minutes (seconds)
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days (seconds)

// ── Auth Service ──────────────────────────────────────────────
class AuthService {

  // ── Register ───────────────────────────────────────────────
  async register(input: RegisterInput): Promise<{ user: UserProfile; tokens: TokenPair }> {
    const existing = await db.queryOne(
      'SELECT id FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );
    if (existing) throw new AppError(409, 'Email already registered', 'EMAIL_EXISTS');

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const user = await db.queryOne<{
      id: string; email: string; name: string;
      credits: number; subscription_tier: string; created_at: string;
    }>(
      `INSERT INTO users (id, email, name, password_hash, credits, subscription_tier)
       VALUES ($1, $2, $3, $4, $5, 'free')
       RETURNING id, email, name, credits, subscription_tier, created_at`,
      [uuidv4(), input.email.toLowerCase(), input.name, passwordHash, config.credits.freeOnSignup]
    );

    if (!user) throw new AppError(500, 'Failed to create user');

    const tokens = await this.issueTokens(user.id, user.email);

    logger.info('User registered', { userId: user.id, email: user.email });

    return {
      user: this.toProfile(user),
      tokens,
    };
  }

  // ── Login ──────────────────────────────────────────────────
  async login(input: LoginInput): Promise<{ user: UserProfile; tokens: TokenPair }> {
    const user = await db.queryOne<{
      id: string; email: string; name: string; password_hash: string;
      credits: number; subscription_tier: string; created_at: string; is_active: boolean;
    }>(
      'SELECT id, email, name, password_hash, credits, subscription_tier, created_at, is_active FROM users WHERE email = $1',
      [input.email.toLowerCase()]
    );

    // Constant-time comparison to prevent timing attacks
    const dummyHash = '$2a$12$invalidhashfortimingequalityXXXXXXXXXXXXXXX';
    const isValid = user
      ? await bcrypt.compare(input.password, user.password_hash)
      : await bcrypt.compare(input.password, dummyHash);

    if (!user || !isValid) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (!user.is_active) {
      throw new UnauthorizedError('Account is deactivated');
    }

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const tokens = await this.issueTokens(user.id, user.email);
    logger.info('User logged in', { userId: user.id });

    return { user: this.toProfile(user), tokens };
  }

  // ── Refresh Tokens ─────────────────────────────────────────
  async refreshTokens(refreshToken: string): Promise<TokenPair> {
    const stored = await db.queryOne<{ user_id: string; expires_at: Date; revoked: boolean }>(
      'SELECT user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = $1',
      [this.hashToken(refreshToken)]
    );

    if (!stored || stored.revoked || new Date() > stored.expires_at) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // Rotate: revoke old, issue new
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1', [
      this.hashToken(refreshToken),
    ]);

    const user = await db.queryOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE id = $1',
      [stored.user_id]
    );
    if (!user) throw new UnauthorizedError('User not found');

    return this.issueTokens(user.id, user.email);
  }

  // ── Logout ─────────────────────────────────────────────────
  async logout(refreshToken: string): Promise<void> {
    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1',
      [this.hashToken(refreshToken)]
    );
  }

  // ── Issue Access + Refresh Tokens ─────────────────────────
  private async issueTokens(userId: string, email: string): Promise<TokenPair> {
    const accessToken = jwt.sign(
      { sub: userId, email },
      config.auth.jwtSecret,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    const refreshToken = uuidv4() + uuidv4(); // 72-char random token

    await db.query(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [this.hashToken(refreshToken), userId]
    );

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL };
  }

  private hashToken(token: string): string {
    // Simple SHA-256 via Node crypto — no need for bcrypt on refresh tokens
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private toProfile(user: {
    id: string; email: string; name: string;
    credits: number; subscription_tier: string; created_at: string;
  }): UserProfile {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      credits: user.credits,
      subscriptionTier: user.subscription_tier,
      createdAt: user.created_at,
    };
  }
}

export const authService = new AuthService();

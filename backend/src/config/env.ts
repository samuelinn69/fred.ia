import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('8000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),

  // Database (Neon / PostgreSQL)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis (Upstash — opcional)
  REDIS_URL: z.string().optional(),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),

  // AI Providers
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  DEFAULT_AI_PROVIDER: z.enum(['anthropic', 'openai', 'local']).default('anthropic'),
  DEFAULT_MODEL: z.string().default('claude-sonnet-4-20250514'),

  // LemonSqueezy
  LEMONSQUEEZY_API_KEY: z.string().min(1, 'LEMONSQUEEZY_API_KEY is required'),
  LEMONSQUEEZY_STORE_ID: z.string().min(1, 'LEMONSQUEEZY_STORE_ID is required'),
  LEMONSQUEEZY_WEBHOOK_SECRET: z.string().min(1, 'LEMONSQUEEZY_WEBHOOK_SECRET is required'),
  LS_VARIANT_STARTER: z.string().min(1, 'LS_VARIANT_STARTER is required'),
  LS_VARIANT_PRO: z.string().min(1, 'LS_VARIANT_PRO is required'),
  LS_VARIANT_CREDITS: z.string().min(1, 'LS_VARIANT_CREDITS is required'),

  // Vector DB
  VECTOR_DB_PROVIDER: z.enum(['pinecone', 'supabase']).default('pinecone'),
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),

  // Credits
  CREDITS_PER_1K_TOKENS: z.string().default('1'),
  FREE_CREDITS_ON_SIGNUP: z.string().default('100'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  server: {
    env:         parsed.data.NODE_ENV,
    port:        parseInt(parsed.data.PORT),
    frontendUrl: parsed.data.FRONTEND_URL,
  },
  database: {
    url: parsed.data.DATABASE_URL,
  },
  auth: {
    jwtSecret:   parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
  },
  ai: {
    provider:       parsed.data.DEFAULT_AI_PROVIDER,
    model:          parsed.data.DEFAULT_MODEL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    openaiApiKey:   parsed.data.OPENAI_API_KEY,
  },
  lemonSqueezy: {
    apiKey:          parsed.data.LEMONSQUEEZY_API_KEY,
    storeId:         parsed.data.LEMONSQUEEZY_STORE_ID,
    webhookSecret:   parsed.data.LEMONSQUEEZY_WEBHOOK_SECRET,
    variantStarter:  parsed.data.LS_VARIANT_STARTER,
    variantPro:      parsed.data.LS_VARIANT_PRO,
    variantCredits:  parsed.data.LS_VARIANT_CREDITS,
  },
  vectorDb: {
    provider: parsed.data.VECTOR_DB_PROVIDER,
    pinecone: {
      apiKey: parsed.data.PINECONE_API_KEY,
      index:  parsed.data.PINECONE_INDEX,
    },
    supabase: {
      url:        parsed.data.SUPABASE_URL,
      serviceKey: parsed.data.SUPABASE_SERVICE_KEY,
    },
  },
  credits: {
    per1kTokens:  parseInt(parsed.data.CREDITS_PER_1K_TOKENS),
    freeOnSignup: parseInt(parsed.data.FREE_CREDITS_ON_SIGNUP),
  },
  rateLimit: {
    windowMs:    parseInt(parsed.data.RATE_LIMIT_WINDOW_MS),
    maxRequests: parseInt(parsed.data.RATE_LIMIT_MAX_REQUESTS),
  },
} as const;

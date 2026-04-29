import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3001'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // AI Providers (at least one required)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Default AI provider
  DEFAULT_AI_PROVIDER: z.enum(['anthropic', 'openai', 'local']).default('anthropic'),
  DEFAULT_MODEL: z.string().default('claude-sonnet-4-20250514'),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1, 'STRIPE_SECRET_KEY is required'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1, 'STRIPE_WEBHOOK_SECRET is required'),
  STRIPE_PUBLISHABLE_KEY: z.string().min(1, 'STRIPE_PUBLISHABLE_KEY is required'),

  // Vector DB (choose one)
  VECTOR_DB_PROVIDER: z.enum(['pinecone', 'supabase']).default('pinecone'),
  PINECONE_API_KEY: z.string().optional(),
  PINECONE_INDEX: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),

  // Credits config
  CREDITS_PER_1K_TOKENS: z.string().default('1'),
  FREE_CREDITS_ON_SIGNUP: z.string().default('100'),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z.string().default('900000'), // 15 min
  RATE_LIMIT_MAX_REQUESTS: z.string().default('100'),

  // CORS
  FRONTEND_URL: z.string().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  server: {
    env: parsed.data.NODE_ENV,
    port: parseInt(parsed.data.PORT),
    frontendUrl: parsed.data.FRONTEND_URL,
  },
  database: {
    url: parsed.data.DATABASE_URL,
  },
  auth: {
    jwtSecret: parsed.data.JWT_SECRET,
    jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
  },
  ai: {
    provider: parsed.data.DEFAULT_AI_PROVIDER,
    model: parsed.data.DEFAULT_MODEL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
  },
  stripe: {
    secretKey: parsed.data.STRIPE_SECRET_KEY,
    webhookSecret: parsed.data.STRIPE_WEBHOOK_SECRET,
    publishableKey: parsed.data.STRIPE_PUBLISHABLE_KEY,
  },
  vectorDb: {
    provider: parsed.data.VECTOR_DB_PROVIDER,
    pinecone: {
      apiKey: parsed.data.PINECONE_API_KEY,
      index: parsed.data.PINECONE_INDEX,
    },
    supabase: {
      url: parsed.data.SUPABASE_URL,
      anonKey: parsed.data.SUPABASE_ANON_KEY,
      serviceKey: parsed.data.SUPABASE_SERVICE_KEY,
    },
  },
  credits: {
    per1kTokens: parseInt(parsed.data.CREDITS_PER_1K_TOKENS),
    freeOnSignup: parseInt(parsed.data.FREE_CREDITS_ON_SIGNUP),
  },
  rateLimit: {
    windowMs: parseInt(parsed.data.RATE_LIMIT_WINDOW_MS),
    maxRequests: parseInt(parsed.data.RATE_LIMIT_MAX_REQUESTS),
  },
} as const;

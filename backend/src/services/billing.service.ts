import crypto from 'crypto';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

// ── Credit packages — map to your LemonSqueezy variant IDs ───
export const CREDIT_PACKAGES = {
  starter: { credits: 500,  variantId: process.env.LS_VARIANT_STARTER!,  usd: 9.99  },
  pro:     { credits: 2000, variantId: process.env.LS_VARIANT_PRO!,      usd: 29.99 },
  credits: { credits: 200,  variantId: process.env.LS_VARIANT_CREDITS!,  usd: 4.99  },
} as const;

export type PackageName = keyof typeof CREDIT_PACKAGES;

// ── LemonSqueezy API helper ───────────────────────────────────
async function lsRequest<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const res = await fetch(`https://api.lemonsqueezy.com/v1${path}`, {
    method,
    headers: {
      'Accept':        'application/vnd.api+json',
      'Content-Type':  'application/vnd.api+json',
      'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new AppError(res.status, `LemonSqueezy error: ${JSON.stringify(err)}`);
  }

  return res.json() as Promise<T>;
}

// ── Billing Service ───────────────────────────────────────────
class BillingService {

  // ── Create Checkout URL ────────────────────────────────────
  async createCheckoutSession(
    userId: string,
    email: string,
    packageName: PackageName
  ): Promise<string> {
    const pkg = CREDIT_PACKAGES[packageName];
    if (!pkg) throw new AppError(400, `Invalid package: ${packageName}`);

    const storeId  = process.env.LEMONSQUEEZY_STORE_ID!;

    const payload = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: {
            email,
            custom: { userId, packageName, creditsToAdd: String(pkg.credits) },
          },
          product_options: {
            redirect_url:     `${process.env.FRONTEND_URL}/billing/success`,
            receipt_link_url: `${process.env.FRONTEND_URL}/billing/success`,
          },
        },
        relationships: {
          store:   { data: { type: 'stores',   id: storeId              } },
          variant: { data: { type: 'variants',  id: pkg.variantId       } },
        },
      },
    };

    const response = await lsRequest<{ data: { attributes: { url: string } } }>(
      '/checkouts', 'POST', payload
    );

    logger.info('LemonSqueezy checkout created', { userId, packageName });
    return response.data.attributes.url;
  }

  // ── Process Webhook ────────────────────────────────────────
  async processWebhook(rawBody: Buffer, signature: string): Promise<void> {
    // Verify HMAC-SHA256 signature
    const secret  = process.env.LEMONSQUEEZY_WEBHOOK_SECRET!;
    const digest  = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    if (digest !== signature) {
      logger.warn('Invalid LemonSqueezy webhook signature');
      throw new AppError(400, 'Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString());
    const eventName: string = event.meta?.event_name ?? '';

    logger.info('LemonSqueezy webhook received', { event: eventName });

    switch (eventName) {
      case 'order_created':
        await this.handleOrderCreated(event);
        break;
      case 'subscription_created':
      case 'subscription_updated':
        await this.handleSubscription(event);
        break;
      case 'subscription_cancelled':
        await this.handleSubscriptionCancelled(event);
        break;
      default:
        logger.debug('Unhandled webhook event', { event: eventName });
    }
  }

  // ── Order Created (one-time credit purchase) ───────────────
  private async handleOrderCreated(event: Record<string, unknown>): Promise<void> {
    const meta       = event.meta as Record<string, unknown>;
    const customData = meta?.custom_data as Record<string, string> | undefined;
    const attributes = (event.data as Record<string, unknown>)?.attributes as Record<string, unknown>;

    const userId       = customData?.userId;
    const creditsToAdd = parseInt(customData?.creditsToAdd ?? '0');
    const orderId      = String((event.data as Record<string, unknown>)?.id ?? '');
    const status       = attributes?.status as string;

    if (!userId || !creditsToAdd) {
      logger.error('Missing custom_data in webhook', { event });
      return;
    }

    // Only credit on paid orders
    if (status !== 'paid') return;

    await db.transaction(async (client) => {
      await client.query(
        `UPDATE users SET credits = credits + $1, updated_at = NOW() WHERE id = $2`,
        [creditsToAdd, userId]
      );
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, type, description)
         VALUES ($1, $2, 'purchase', $3)
         ON CONFLICT DO NOTHING`,
        [userId, creditsToAdd, `Purchased ${creditsToAdd} credits (order ${orderId})`]
      );
    });

    logger.info('Credits added via LemonSqueezy', { userId, creditsToAdd, orderId });
  }

  // ── Subscription events ────────────────────────────────────
  private async handleSubscription(event: Record<string, unknown>): Promise<void> {
    const meta       = event.meta as Record<string, unknown>;
    const customData = meta?.custom_data as Record<string, string> | undefined;
    const attributes = (event.data as Record<string, unknown>)?.attributes as Record<string, string>;

    const userId = customData?.userId;
    const status = attributes?.status; // active | past_due | cancelled | etc.
    if (!userId) return;

    const tier = status === 'active' ? 'pro' : 'free';
    await db.query(
      `UPDATE users SET subscription_tier = $1, updated_at = NOW() WHERE id = $2`,
      [tier, userId]
    );

    logger.info('Subscription updated', { userId, status, tier });
  }

  private async handleSubscriptionCancelled(event: Record<string, unknown>): Promise<void> {
    const meta       = event.meta as Record<string, unknown>;
    const customData = meta?.custom_data as Record<string, string> | undefined;
    const userId     = customData?.userId;
    if (!userId) return;

    await db.query(
      `UPDATE users SET subscription_tier = 'free', updated_at = NOW() WHERE id = $1`,
      [userId]
    );
    logger.info('Subscription cancelled', { userId });
  }

  // ── Get balance ────────────────────────────────────────────
  async getBalance(userId: string): Promise<{ credits: number; transactions: unknown[] }> {
    const [user, transactions] = await Promise.all([
      db.queryOne<{ credits: number }>(
        'SELECT credits FROM users WHERE id = $1', [userId]
      ),
      db.query(
        `SELECT amount, type, description, created_at
         FROM credit_transactions WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [userId]
      ),
    ]);
    return { credits: user?.credits ?? 0, transactions };
  }
}

export const billingService = new BillingService();

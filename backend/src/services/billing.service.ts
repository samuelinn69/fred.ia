import Stripe from 'stripe';
import { config } from '../config/env';
import { db } from '../config/database';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-06-20',
  typescript: true,
});

// ── Credit packages available for purchase ───────────────────
export const CREDIT_PACKAGES = {
  starter: { credits: 500, priceId: process.env.STRIPE_PRICE_STARTER!, usd: 9.99 },
  pro:     { credits: 2000, priceId: process.env.STRIPE_PRICE_PRO!,     usd: 29.99 },
  credits: { credits: 200,  priceId: process.env.STRIPE_PRICE_CREDITS!, usd: 4.99 },
} as const;

export type PackageName = keyof typeof CREDIT_PACKAGES;

// ── Billing Service ───────────────────────────────────────────
class BillingService {

  // ── Create Checkout Session ────────────────────────────────
  async createCheckoutSession(
    userId: string,
    email: string,
    packageName: PackageName
  ): Promise<string> {
    const pkg = CREDIT_PACKAGES[packageName];
    if (!pkg) throw new AppError(400, `Invalid package: ${packageName}`);

    // Retrieve or create Stripe customer
    const stripeCustomerId = await this.getOrCreateCustomer(userId, email);

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price: pkg.priceId,
        quantity: 1,
      }],
      success_url: `${config.server.frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.server.frontendUrl}/billing/cancelled`,
      metadata: {
        userId,
        packageName,
        creditsToAdd: String(pkg.credits),
      },
    });

    logger.info('Checkout session created', { userId, packageName, sessionId: session.id });
    return session.url!;
  }

  // ── Create Billing Portal Session ─────────────────────────
  async createPortalSession(userId: string): Promise<string> {
    const user = await db.queryOne<{ stripe_customer_id: string }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (!user?.stripe_customer_id) {
      throw new AppError(400, 'No billing account found. Purchase a plan first.');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${config.server.frontendUrl}/dashboard/billing`,
    });

    return session.url;
  }

  // ── Process Stripe Webhook ─────────────────────────────────
  async processWebhook(rawBody: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        config.stripe.webhookSecret
      );
    } catch (err) {
      logger.warn('Invalid webhook signature', { error: (err as Error).message });
      throw new AppError(400, 'Invalid webhook signature');
    }

    logger.info('Stripe webhook received', { type: event.type, id: event.id });

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      case 'invoice.payment_succeeded':
        await this.handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await this.handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionCancelled(event.data.object as Stripe.Subscription);
        break;

      default:
        logger.debug('Unhandled webhook event', { type: event.type });
    }
  }

  // ── Webhook Handlers ───────────────────────────────────────
  private async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const { userId, creditsToAdd } = session.metadata ?? {};
    if (!userId || !creditsToAdd) {
      logger.error('Missing metadata in checkout session', { sessionId: session.id });
      return;
    }

    const credits = parseInt(creditsToAdd);

    await db.transaction(async (client) => {
      // Add credits
      await client.query(
        `UPDATE users SET credits = credits + $1, updated_at = NOW() WHERE id = $2`,
        [credits, userId]
      );

      // Record transaction
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, type, stripe_session_id, description)
         VALUES ($1, $2, 'purchase', $3, $4)`,
        [userId, credits, session.id, `Purchased ${credits} credits`]
      );
    });

    logger.info('Credits added', { userId, credits, sessionId: session.id });
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user = await db.queryOne<{ id: string }>(
      'SELECT id FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (!user) return;

    await db.query(
      `INSERT INTO payment_events (user_id, stripe_event_type, amount_cents, stripe_invoice_id)
       VALUES ($1, 'invoice.paid', $2, $3)
       ON CONFLICT (stripe_invoice_id) DO NOTHING`,
      [user.id, invoice.amount_paid, invoice.id]
    );

    logger.info('Invoice paid recorded', { userId: user.id, invoiceId: invoice.id });
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const customerId = invoice.customer as string;
    const user = await db.queryOne<{ id: string; email: string }>(
      'SELECT id, email FROM users WHERE stripe_customer_id = $1',
      [customerId]
    );

    if (!user) return;

    logger.warn('Payment failed', { userId: user.id, email: user.email, invoiceId: invoice.id });
    // TODO: trigger email notification
  }

  private async handleSubscriptionCancelled(sub: Stripe.Subscription): Promise<void> {
    const customerId = sub.customer as string;
    await db.query(
      `UPDATE users SET subscription_tier = 'free', updated_at = NOW()
       WHERE stripe_customer_id = $1`,
      [customerId]
    );
    logger.info('Subscription cancelled', { customerId });
  }

  // ── Get or Create Stripe Customer ─────────────────────────
  private async getOrCreateCustomer(userId: string, email: string): Promise<string> {
    const user = await db.queryOne<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (user?.stripe_customer_id) return user.stripe_customer_id;

    const customer = await stripe.customers.create({
      email,
      metadata: { userId },
    });

    await db.query(
      'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, userId]
    );

    return customer.id;
  }

  // ── Get credit balance ─────────────────────────────────────
  async getBalance(userId: string): Promise<{ credits: number; transactions: unknown[] }> {
    const [user, transactions] = await Promise.all([
      db.queryOne<{ credits: number }>(
        'SELECT credits FROM users WHERE id = $1',
        [userId]
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

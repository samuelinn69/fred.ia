import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.middleware';
import { billingService, PackageName } from '../../services/billing.service';

export const billingRoutes = Router();

const checkoutSchema = z.object({
  packageName: z.enum(['starter', 'pro', 'credits']),
});

// ── POST /api/billing/checkout ────────────────────────────────
billingRoutes.post(
  '/checkout',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const { packageName } = checkoutSchema.parse(req.body);

      const url = await billingService.createCheckoutSession(
        authReq.user.id,
        authReq.user.email,
        packageName as PackageName
      );

      res.json({ url });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/billing/portal ──────────────────────────────────
billingRoutes.post(
  '/portal',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const url = await billingService.createPortalSession(authReq.user.id);
      res.json({ url });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/billing/balance ──────────────────────────────────
billingRoutes.get(
  '/balance',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const data = await billingService.getBalance(authReq.user.id);
      res.json(data);
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/billing/webhook (Stripe — raw body) ────────────
billingRoutes.post(
  '/webhook',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sig = req.headers['stripe-signature'];
      if (!sig || typeof sig !== 'string') {
        res.status(400).json({ error: 'Missing stripe-signature header' });
        return;
      }

      await billingService.processWebhook(req.body as Buffer, sig);
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);

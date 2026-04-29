import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, AuthenticatedRequest } from '../../middleware/auth.middleware';
import { memoryService } from '../../services/memory.service';

export const memoryRoutes = Router();

// ── GET /api/memory/search?q= ─────────────────────────────────
memoryRoutes.get(
  '/search',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const query = String(req.query.q ?? '').trim();
      if (!query) { res.json({ memories: [] }); return; }

      const memories = await memoryService.retrieveRelevantMemories(
        authReq.user.id,
        query,
        10
      );
      res.json({ memories });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/memory  (GDPR right-to-forget) ───────────────
memoryRoutes.delete(
  '/',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      await memoryService.deleteUserMemories(authReq.user.id);
      res.json({ success: true, message: 'All memories deleted' });
    } catch (err) {
      next(err);
    }
  }
);

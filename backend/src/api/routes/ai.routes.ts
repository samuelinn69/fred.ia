import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireCredits, deductCredits, AuthenticatedRequest } from '../../middleware/auth.middleware';
import { aiService } from '../../services/ai.service';
import { memoryService } from '../../services/memory.service';
import { db } from '../../config/database';
import { logger } from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export const aiRoutes = Router();

// ── Validation Schemas ────────────────────────────────────────
const chatSchema = z.object({
  message: z.string().min(1).max(32_000),
  conversationId: z.string().uuid().optional(),
  systemPrompt: z.string().max(8000).optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  useMemory: z.boolean().default(true),
});

// ── POST /api/ai/chat  (streaming) ────────────────────────────
aiRoutes.post(
  '/chat',
  authenticate,
  requireCredits(1),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    let parsed;
    try {
      parsed = chatSchema.parse(req.body);
    } catch (err) {
      next(err);
      return;
    }

    const { message, conversationId, systemPrompt, model, temperature, maxTokens, useMemory } = parsed;
    const userId = authReq.user.id;
    const convId = conversationId ?? uuidv4();

    try {
      // 1. Fetch conversation history
      const history = await db.query<{ role: string; content: string }>(
        `SELECT role, content FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at ASC
         LIMIT 20`,
        [convId]
      );

      // 2. Build system prompt enriched with long-term memory
      const baseSystem = systemPrompt ?? 'You are a helpful, intelligent AI assistant.';
      const enrichedSystem = useMemory
        ? await memoryService.buildContextualSystemPrompt(userId, message, baseSystem)
        : baseSystem;

      // 3. Compose messages array
      const messages = [
        ...history.map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        { role: 'user' as const, content: message },
      ];

      // 4. Persist the user message
      await db.query(
        `INSERT INTO messages (id, conversation_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', $4)`,
        [uuidv4(), convId, userId, message]
      );

      // 5. Stream AI response
      const result = await aiService.streamCompletion(
        { messages, systemPrompt: enrichedSystem, model, temperature, maxTokens },
        res
      );

      // ── Post-stream tasks (non-blocking) ────────────────────
      setImmediate(async () => {
        try {
          // Persist assistant response
          await db.query(
            `INSERT INTO messages (id, conversation_id, user_id, role, content, tokens_used)
             VALUES ($1, $2, $3, 'assistant', $4, $5)`,
            [uuidv4(), convId, userId, result.content, result.totalTokens]
          );

          // Deduct credits
          await deductCredits(userId, result.totalTokens);

          // Store memory (summarize the exchange)
          if (useMemory && result.totalTokens > 50) {
            await memoryService.storeMemory(
              userId,
              `User: ${message}\nAssistant: ${result.content}`,
              { conversationId: convId, model: result.model }
            );
          }

          logger.info('Chat completed', {
            userId,
            convId,
            tokens: result.totalTokens,
            provider: result.provider,
          });
        } catch (postErr) {
          logger.error('Post-stream task failed', { error: (postErr as Error).message });
        }
      });

    } catch (err) {
      if (!res.headersSent) next(err);
    }
  }
);

// ── GET /api/ai/conversations ─────────────────────────────────
aiRoutes.get(
  '/conversations',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const conversations = await db.query(
        `SELECT
           conversation_id,
           MIN(created_at) as started_at,
           MAX(created_at) as last_message_at,
           COUNT(*) as message_count,
           (SELECT content FROM messages m2
            WHERE m2.conversation_id = m.conversation_id AND m2.role = 'user'
            ORDER BY m2.created_at ASC LIMIT 1) as title
         FROM messages m
         WHERE user_id = $1
         GROUP BY conversation_id
         ORDER BY last_message_at DESC
         LIMIT 50`,
        [authReq.user.id]
      );
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/ai/conversations/:id ────────────────────────────
aiRoutes.get(
  '/conversations/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const messages = await db.query(
        `SELECT id, role, content, tokens_used, created_at
         FROM messages
         WHERE conversation_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [req.params.id, authReq.user.id]
      );
      res.json({ conversationId: req.params.id, messages });
    } catch (err) {
      next(err);
    }
  }
);

// ── DELETE /api/ai/conversations/:id ────────────────────────
aiRoutes.delete(
  '/conversations/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      await db.query(
        'DELETE FROM messages WHERE conversation_id = $1 AND user_id = $2',
        [req.params.id, authReq.user.id]
      );
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

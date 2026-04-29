import { Pinecone } from '@pinecone-database/pinecone';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────
export interface MemoryEntry {
  id: string;
  userId: string;
  content: string;
  summary: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface RelevantMemory {
  content: string;
  summary: string;
  score: number;
  createdAt: string;
}

const EMBEDDING_DIMENSION = 1536; // OpenAI text-embedding-3-small / ada-002
const MEMORY_NAMESPACE_PREFIX = 'user_memory_';

// ── Memory Service ────────────────────────────────────────────
class MemoryService {
  private pinecone?: Pinecone;
  private supabase?: ReturnType<typeof createClient>;
  private openai?: OpenAI;
  private anthropic?: Anthropic;

  constructor() {
    // Embedding provider (prefers OpenAI, falls back to Anthropic)
    if (config.ai.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.ai.openaiApiKey });
    }
    if (config.ai.anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: config.ai.anthropicApiKey });
    }

    // Vector DB
    if (config.vectorDb.provider === 'pinecone' && config.vectorDb.pinecone.apiKey) {
      this.pinecone = new Pinecone({ apiKey: config.vectorDb.pinecone.apiKey });
    } else if (
      config.vectorDb.provider === 'supabase' &&
      config.vectorDb.supabase.url &&
      config.vectorDb.supabase.serviceKey
    ) {
      this.supabase = createClient(
        config.vectorDb.supabase.url,
        config.vectorDb.supabase.serviceKey
      );
    }
  }

  // ── Generate Embedding ─────────────────────────────────────
  async generateEmbedding(text: string): Promise<number[]> {
    if (this.openai) {
      const resp = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: EMBEDDING_DIMENSION,
      });
      return resp.data[0].embedding;
    }

    // Fallback: simple hash-based pseudo-embedding (replace with real model in prod)
    logger.warn('No embedding provider configured — using deterministic placeholder');
    return this.deterministicEmbedding(text);
  }

  // ── Store a memory for a user ──────────────────────────────
  async storeMemory(
    userId: string,
    conversationText: string,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      // Generate a concise summary for storage
      const summary = await this.summarizeForMemory(conversationText);
      const embedding = await this.generateEmbedding(summary);
      const memoryId = `mem_${userId}_${Date.now()}`;

      if (config.vectorDb.provider === 'pinecone' && this.pinecone) {
        const index = this.pinecone.index(config.vectorDb.pinecone.index!);
        const namespace = index.namespace(`${MEMORY_NAMESPACE_PREFIX}${userId}`);

        await namespace.upsert([{
          id: memoryId,
          values: embedding,
          metadata: {
            userId,
            content: conversationText.slice(0, 1000), // Pinecone metadata limit
            summary,
            createdAt: new Date().toISOString(),
            ...metadata,
          },
        }]);

      } else if (config.vectorDb.provider === 'supabase' && this.supabase) {
        await this.supabase.from('user_memories').insert({
          id: memoryId,
          user_id: userId,
          content: conversationText,
          summary,
          embedding: JSON.stringify(embedding),
          metadata,
          created_at: new Date().toISOString(),
        });
      }

      logger.debug('Memory stored', { userId, memoryId });
    } catch (err) {
      logger.error('Failed to store memory', { userId, error: (err as Error).message });
      // Non-fatal: don't crash the request if memory storage fails
    }
  }

  // ── Retrieve relevant memories for a query ─────────────────
  async retrieveRelevantMemories(
    userId: string,
    query: string,
    topK = 5,
    minScore = 0.7
  ): Promise<RelevantMemory[]> {
    try {
      const queryEmbedding = await this.generateEmbedding(query);

      if (config.vectorDb.provider === 'pinecone' && this.pinecone) {
        const index = this.pinecone.index(config.vectorDb.pinecone.index!);
        const namespace = index.namespace(`${MEMORY_NAMESPACE_PREFIX}${userId}`);

        const results = await namespace.query({
          vector: queryEmbedding,
          topK,
          includeMetadata: true,
        });

        return (results.matches ?? [])
          .filter((m) => (m.score ?? 0) >= minScore)
          .map((m) => ({
            content: String(m.metadata?.content ?? ''),
            summary: String(m.metadata?.summary ?? ''),
            score: m.score ?? 0,
            createdAt: String(m.metadata?.createdAt ?? ''),
          }));

      } else if (config.vectorDb.provider === 'supabase' && this.supabase) {
        // Supabase pgvector cosine similarity search
        const { data, error } = await this.supabase.rpc('match_memories', {
          query_embedding: queryEmbedding,
          match_user_id: userId,
          match_threshold: minScore,
          match_count: topK,
        });

        if (error) throw error;

        return (data ?? []).map((row: Record<string, unknown>) => ({
          content: String(row.content),
          summary: String(row.summary),
          score: Number(row.similarity),
          createdAt: String(row.created_at),
        }));
      }

      return [];
    } catch (err) {
      logger.error('Failed to retrieve memories', { userId, error: (err as Error).message });
      return [];
    }
  }

  // ── Build enriched system prompt with memory context ───────
  async buildContextualSystemPrompt(
    userId: string,
    userQuery: string,
    baseSystemPrompt: string
  ): Promise<string> {
    const memories = await this.retrieveRelevantMemories(userId, userQuery);

    if (memories.length === 0) return baseSystemPrompt;

    const memoryContext = memories
      .map((m, i) => `[Memory ${i + 1} — ${m.createdAt}]: ${m.summary}`)
      .join('\n');

    return `${baseSystemPrompt}

## Relevant Context From Previous Conversations
The following are summaries of relevant past interactions with this user. Use them to provide
a personalized, contextually aware response. Do NOT explicitly reference these as "memories."

${memoryContext}

---`;
  }

  // ── Delete all memories for a user (GDPR / right-to-forget) ─
  async deleteUserMemories(userId: string): Promise<void> {
    if (config.vectorDb.provider === 'pinecone' && this.pinecone) {
      const index = this.pinecone.index(config.vectorDb.pinecone.index!);
      const namespace = index.namespace(`${MEMORY_NAMESPACE_PREFIX}${userId}`);
      await namespace.deleteAll();
    } else if (config.vectorDb.provider === 'supabase' && this.supabase) {
      await this.supabase.from('user_memories').delete().eq('user_id', userId);
    }
    logger.info('User memories deleted', { userId });
  }

  // ── Summarize conversation for efficient storage ───────────
  private async summarizeForMemory(text: string): Promise<string> {
    if (text.length < 200) return text;

    try {
      if (this.anthropic) {
        const resp = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Summarize the following conversation in 1-3 concise sentences, capturing key facts, preferences, and decisions:\n\n${text.slice(0, 3000)}`,
          }],
        });
        return resp.content[0].type === 'text' ? resp.content[0].text : text.slice(0, 500);
      }
    } catch {
      // Fallback to truncation
    }
    return text.slice(0, 500);
  }

  // ── Deterministic placeholder embedding (dev/no-provider) ──
  private deterministicEmbedding(text: string): number[] {
    const embedding = new Array(EMBEDDING_DIMENSION).fill(0);
    for (let i = 0; i < text.length; i++) {
      embedding[i % EMBEDDING_DIMENSION] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return embedding.map((v) => v / (magnitude || 1));
  }
}

export const memoryService = new MemoryService();

import { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config/env';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AICompletionOptions {
  messages: ChatMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface AICompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
}

// ── AI Service ────────────────────────────────────────────────
class AIService {
  private anthropic?: Anthropic;
  private openai?: OpenAI;

  constructor() {
    if (config.ai.anthropicApiKey) {
      this.anthropic = new Anthropic({ apiKey: config.ai.anthropicApiKey });
    }
    if (config.ai.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.ai.openaiApiKey });
    }
  }

  // ── Streaming (SSE to HTTP response) ──────────────────────
  async streamCompletion(
    opts: AICompletionOptions,
    res: Response
  ): Promise<AICompletionResult> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx proxy buffering

    const provider = config.ai.provider;
    const model = opts.model ?? config.ai.model;

    logger.info('Streaming completion', { provider, model });

    try {
      if (provider === 'anthropic') return await this.streamAnthropic(opts, model, res);
      if (provider === 'openai') return await this.streamOpenAI(opts, model, res);
      return await this.streamLocal(opts, model, res);
    } catch (err) {
      const msg = (err as Error).message;
      logger.error('Stream error', { provider, error: msg });
      if (!res.headersSent) res.status(500);
      res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      res.end();
      throw err;
    }
  }

  // ── Anthropic Claude ───────────────────────────────────────
  private async streamAnthropic(
    opts: AICompletionOptions,
    model: string,
    res: Response
  ): Promise<AICompletionResult> {
    if (!this.anthropic) throw new Error('Anthropic not configured. Set ANTHROPIC_API_KEY.');

    const messages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await this.anthropic.messages.stream({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
      system: opts.systemPrompt,
      messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullContent += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ delta: chunk.delta.text })}\n\n`);
      }
      if (chunk.type === 'message_start') inputTokens = chunk.message.usage.input_tokens;
      if (chunk.type === 'message_delta' && chunk.usage) outputTokens = chunk.usage.output_tokens;
    }

    res.write(`data: ${JSON.stringify({ done: true, inputTokens, outputTokens })}\n\n`);
    res.end();

    return { content: fullContent, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model, provider: 'anthropic' };
  }

  // ── OpenAI GPT ─────────────────────────────────────────────
  private async streamOpenAI(
    opts: AICompletionOptions,
    model: string,
    res: Response
  ): Promise<AICompletionResult> {
    if (!this.openai) throw new Error('OpenAI not configured. Set OPENAI_API_KEY.');

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
      ...opts.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = await this.openai.chat.completions.create({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
      stream: true,
      stream_options: { include_usage: true },
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        fullContent += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, inputTokens, outputTokens })}\n\n`);
    res.end();

    return { content: fullContent, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model, provider: 'openai' };
  }

  // ── Local LLM via Ollama (OpenAI-compatible API) ───────────
  private async streamLocal(
    opts: AICompletionOptions,
    model: string,
    res: Response
  ): Promise<AICompletionResult> {
    const localClient = new OpenAI({
      baseURL: `${process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434'}/v1`,
      apiKey: 'ollama', // Ollama accepts any string
    });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(opts.systemPrompt ? [{ role: 'system' as const, content: opts.systemPrompt }] : []),
      ...opts.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    let fullContent = '';
    let outputTokens = 0;

    const stream = await localClient.chat.completions.create({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) {
        fullContent += delta;
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    }

    outputTokens = Math.ceil(fullContent.length / 4); // Estimate
    res.write(`data: ${JSON.stringify({ done: true, inputTokens: 0, outputTokens })}\n\n`);
    res.end();

    return { content: fullContent, inputTokens: 0, outputTokens, totalTokens: outputTokens, model, provider: 'local' };
  }

  // ── Non-streaming (embeddings, internal tasks) ─────────────
  async complete(opts: AICompletionOptions): Promise<AICompletionResult> {
    const provider = config.ai.provider;
    const model = opts.model ?? config.ai.model;

    if (provider === 'anthropic' && this.anthropic) {
      const messages = opts.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

      const resp = await this.anthropic.messages.create({
        model, max_tokens: opts.maxTokens ?? 1024,
        system: opts.systemPrompt, messages,
      });

      const content = resp.content[0].type === 'text' ? resp.content[0].text : '';
      return {
        content,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
        model, provider: 'anthropic',
      };
    }

    if (provider === 'openai' && this.openai) {
      const resp = await this.openai.chat.completions.create({
        model,
        messages: opts.messages as OpenAI.ChatCompletionMessageParam[],
        max_tokens: opts.maxTokens ?? 1024,
      });
      return {
        content: resp.choices[0].message.content ?? '',
        inputTokens: resp.usage?.prompt_tokens ?? 0,
        outputTokens: resp.usage?.completion_tokens ?? 0,
        totalTokens: resp.usage?.total_tokens ?? 0,
        model, provider: 'openai',
      };
    }

    throw new Error(`AI provider "${provider}" not configured or missing API key.`);
  }
}

export const aiService = new AIService();

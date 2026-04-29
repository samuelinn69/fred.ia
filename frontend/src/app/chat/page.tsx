'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Zap, Brain, Trash2, Plus } from 'lucide-react';
import { chat, billing, type Message, type ChatStreamEvent } from '@/lib/api';
import { clsx } from 'clsx';

interface ChatState {
  conversationId: string | null;
  messages: Message[];
  streaming: boolean;
  streamBuffer: string;
  credits: number;
  error: string | null;
}

export default function ChatPage() {
  const [state, setState] = useState<ChatState>({
    conversationId: null,
    messages: [],
    streaming: false,
    streamBuffer: '',
    credits: 0,
    error: null,
  });
  const [input, setInput] = useState('');
  const [useMemory, setUseMemory] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Fetch credit balance ──────────────────────────────────
  useEffect(() => {
    billing.balance().then((d) =>
      setState((s) => ({ ...s, credits: d.credits }))
    ).catch(() => {});
  }, []);

  // ── Auto-scroll to bottom ─────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, state.streamBuffer]);

  // ── Send Message ──────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || state.streaming) return;

    setInput('');
    setState((s) => ({
      ...s,
      streaming: true,
      streamBuffer: '',
      error: null,
      messages: [
        ...s.messages,
        { id: Date.now().toString(), role: 'user', content: trimmed, tokens_used: 0, created_at: new Date().toISOString() },
      ],
    }));

    try {
      let fullResponse = '';
      const stream = chat.stream({
        message: trimmed,
        conversationId: state.conversationId ?? undefined,
        useMemory,
      });

      for await (const event of stream) {
        if (event.error) throw new Error(event.error);
        if (event.delta) {
          fullResponse += event.delta;
          setState((s) => ({ ...s, streamBuffer: fullResponse }));
        }
        if (event.done) {
          setState((s) => ({
            ...s,
            streaming: false,
            streamBuffer: '',
            credits: Math.max(0, s.credits - Math.ceil((event.outputTokens ?? 0) / 1000)),
            messages: [
              ...s.messages,
              {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: fullResponse,
                tokens_used: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
                created_at: new Date().toISOString(),
              },
            ],
          }));
        }
      }
    } catch (err) {
      setState((s) => ({
        ...s,
        streaming: false,
        streamBuffer: '',
        error: (err as Error).message,
      }));
    }
  }, [input, state.streaming, state.conversationId, useMemory]);

  // ── Keyboard shortcut ─────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── New Conversation ──────────────────────────────────────
  const newConversation = () =>
    setState({ conversationId: null, messages: [], streaming: false, streamBuffer: '', credits: state.credits, error: null });

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
            <Brain size={16} className="text-white" />
          </div>
          <h1 className="font-semibold text-white">AI Platform</h1>
        </div>

        <div className="flex items-center gap-4">
          {/* Memory toggle */}
          <button
            onClick={() => setUseMemory((v) => !v)}
            className={clsx(
              'flex items-center gap-2 text-sm px-3 py-1.5 rounded-full transition-colors',
              useMemory
                ? 'bg-violet-600/20 text-violet-400 border border-violet-500/30'
                : 'text-gray-500 border border-gray-700 hover:text-gray-300'
            )}
          >
            <Brain size={13} />
            Memory {useMemory ? 'ON' : 'OFF'}
          </button>

          {/* Credits */}
          <div className="flex items-center gap-1.5 text-sm text-amber-400">
            <Zap size={14} />
            <span>{state.credits.toLocaleString()} credits</span>
          </div>

          {/* New chat */}
          <button
            onClick={newConversation}
            className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl mx-auto w-full">
        {state.messages.length === 0 && !state.streaming && (
          <div className="flex flex-col items-center justify-center h-full text-center py-24">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center mb-5 shadow-lg shadow-violet-900/40">
              <Brain size={28} className="text-white" />
            </div>
            <h2 className="text-xl font-semibold text-white mb-2">Start a conversation</h2>
            <p className="text-gray-500 max-w-sm">
              Ask me anything. I remember your previous conversations to give you personalised answers.
            </p>
          </div>
        )}

        {state.messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Streaming bubble */}
        {state.streaming && state.streamBuffer && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 flex-shrink-0 mt-1" />
            <div className="flex-1 bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap max-w-full">
              {state.streamBuffer}
              <span className="inline-block w-1.5 h-4 bg-violet-400 ml-0.5 animate-pulse rounded" />
            </div>
          </div>
        )}

        {/* Error */}
        {state.error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl px-4 py-3 text-red-400 text-sm">
            ⚠ {state.error}
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      {/* Input */}
      <div className="px-4 pb-6 pt-2 max-w-3xl mx-auto w-full">
        <div className="relative flex items-end gap-3 bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 focus-within:border-violet-500 transition-colors">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message AI Platform..."
            rows={1}
            className="flex-1 bg-transparent resize-none text-sm text-gray-100 placeholder-gray-500 outline-none max-h-40 leading-relaxed"
            style={{ minHeight: '1.5rem' }}
          />
          <button
            onClick={state.streaming ? () => abortRef.current?.abort() : sendMessage}
            disabled={!input.trim() && !state.streaming}
            className={clsx(
              'w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-all',
              state.streaming
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : input.trim()
                  ? 'bg-violet-600 hover:bg-violet-500 text-white'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            )}
          >
            {state.streaming ? <Square size={14} /> : <Send size={14} />}
          </button>
        </div>
        <p className="text-center text-xs text-gray-600 mt-2">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}

// ── Message bubble component ──────────────────────────────────
function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className={clsx('flex gap-3', isUser && 'flex-row-reverse')}>
      <div className={clsx(
        'w-7 h-7 rounded-full flex-shrink-0 mt-1 flex items-center justify-center text-xs font-bold',
        isUser ? 'bg-gray-700 text-gray-300' : 'bg-gradient-to-br from-violet-500 to-indigo-600 text-white'
      )}>
        {isUser ? 'U' : 'AI'}
      </div>
      <div className={clsx(
        'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap',
        isUser
          ? 'bg-violet-700/30 border border-violet-600/30 rounded-tr-sm text-gray-100'
          : 'bg-gray-800 rounded-tl-sm text-gray-100'
      )}>
        {message.content}
        {message.tokens_used > 0 && (
          <div className="mt-1.5 text-xs text-gray-600">{message.tokens_used} tokens</div>
        )}
      </div>
    </div>
  );
}

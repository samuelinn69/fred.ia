// ── API base URL ─────────────────────────────────────────────
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// ── Token storage (memory + localStorage for refresh) ────────
let accessToken: string | null = null;

export const tokenStore = {
  setTokens(access: string, refresh: string) {
    accessToken = access;
    if (typeof window !== 'undefined') {
      localStorage.setItem('refresh_token', refresh);
    }
  },
  getAccess: () => accessToken,
  getRefresh: () =>
    typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null,
  clear() {
    accessToken = null;
    if (typeof window !== 'undefined') localStorage.removeItem('refresh_token');
  },
};

// ── Core fetch wrapper with auto-refresh ─────────────────────
async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retry = true
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };

  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401 && retry) {
    const refreshToken = tokenStore.getRefresh();
    if (refreshToken) {
      try {
        const refreshRes = await fetch(`${BASE_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          tokenStore.setTokens(data.tokens.accessToken, data.tokens.refreshToken);
          return apiFetch<T>(path, options, false);
        }
      } catch {
        // Refresh failed — force logout
      }
    }
    tokenStore.clear();
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new ApiError(res.status, error.error ?? 'Unknown error', error.code);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Auth ──────────────────────────────────────────────────────
export const auth = {
  register: (data: { email: string; password: string; name: string }) =>
    apiFetch<{ user: User; tokens: Tokens }>('/api/auth/register', {
      method: 'POST', body: JSON.stringify(data),
    }),

  login: (data: { email: string; password: string }) =>
    apiFetch<{ user: User; tokens: Tokens }>('/api/auth/login', {
      method: 'POST', body: JSON.stringify(data),
    }),

  logout: () => {
    const rt = tokenStore.getRefresh();
    tokenStore.clear();
    return apiFetch('/api/auth/logout', {
      method: 'POST', body: JSON.stringify({ refreshToken: rt }),
    });
  },

  me: () => apiFetch<{ user: User }>('/api/auth/me'),
};

// ── Chat (streaming) ──────────────────────────────────────────
export const chat = {
  async *stream(payload: {
    message: string;
    conversationId?: string;
    systemPrompt?: string;
    useMemory?: boolean;
  }): AsyncGenerator<ChatStreamEvent> {
    const res = await fetch(`${BASE_URL}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Stream failed' }));
      throw new ApiError(res.status, error.error);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data) yield JSON.parse(data) as ChatStreamEvent;
        }
      }
    }
  },

  getConversations: () =>
    apiFetch<{ conversations: Conversation[] }>('/api/ai/conversations'),

  getConversation: (id: string) =>
    apiFetch<{ conversationId: string; messages: Message[] }>(`/api/ai/conversations/${id}`),

  deleteConversation: (id: string) =>
    apiFetch(`/api/ai/conversations/${id}`, { method: 'DELETE' }),
};

// ── Billing ───────────────────────────────────────────────────
export const billing = {
  checkout: (packageName: 'starter' | 'pro' | 'credits') =>
    apiFetch<{ url: string }>('/api/billing/checkout', {
      method: 'POST', body: JSON.stringify({ packageName }),
    }),

  portal: () =>
    apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST' }),

  balance: () =>
    apiFetch<{ credits: number; transactions: CreditTransaction[] }>('/api/billing/balance'),
};

// ── Memory ────────────────────────────────────────────────────
export const memory = {
  search: (q: string) =>
    apiFetch<{ memories: RelevantMemory[] }>(`/api/memory/search?q=${encodeURIComponent(q)}`),

  deleteAll: () => apiFetch('/api/memory', { method: 'DELETE' }),
};

// ── Types ─────────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  name: string;
  credits: number;
  subscriptionTier: string;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ChatStreamEvent {
  delta?: string;
  done?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface Conversation {
  conversation_id: string;
  started_at: string;
  last_message_at: string;
  message_count: number;
  title: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tokens_used: number;
  created_at: string;
}

export interface CreditTransaction {
  amount: number;
  type: string;
  description: string;
  created_at: string;
}

export interface RelevantMemory {
  content: string;
  summary: string;
  score: number;
  createdAt: string;
}

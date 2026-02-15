import type { BotSettings, BotState, UniverseState } from './types';

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

export const API_BASE = backendUrl;
export const WS_URL = backendUrl.replace(/^http/, 'ws') + '/ws';

export class ApiRequestError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  const body = (await response.json()) as T & { ok?: boolean; error?: string | { code?: string; message?: string } };

  if (!response.ok) {
    const errorField = body.error;
    if (typeof errorField === 'string') {
      throw new ApiRequestError(errorField, errorField);
    }

    if (errorField && typeof errorField === 'object') {
      throw new ApiRequestError(errorField.message ?? errorField.code ?? `HTTP ${response.status}`, errorField.code);
    }

    throw new ApiRequestError(`HTTP ${response.status}`);
  }

  return body as T;
}

export async function getHealth(): Promise<{ ok: boolean }> {
  return request('/health');
}

export async function getUniverse(): Promise<UniverseState> {
  return request('/api/universe');
}

export async function createUniverse(minVolPct: number): Promise<unknown> {
  return request('/api/universe/create', {
    method: 'POST',
    body: JSON.stringify({ minVolPct })
  });
}

export async function refreshUniverse(minVolPct?: number): Promise<unknown> {
  return request('/api/universe/refresh', {
    method: 'POST',
    body: JSON.stringify(minVolPct === undefined ? {} : { minVolPct })
  });
}

export async function clearUniverse(): Promise<{ ok: boolean }> {
  return request('/api/universe/clear', { method: 'POST', body: JSON.stringify({}) });
}

export async function getBotState(): Promise<BotState> {
  return request('/api/bot/state');
}

export async function startBot(settings: BotSettings): Promise<unknown> {
  return request('/api/bot/start', { method: 'POST', body: JSON.stringify(settings) });
}

export async function stopBot(): Promise<unknown> {
  return request('/api/bot/stop', { method: 'POST', body: JSON.stringify({}) });
}

export async function pauseBot(): Promise<unknown> {
  return request('/api/bot/pause', { method: 'POST', body: JSON.stringify({}) });
}

export async function resumeBot(): Promise<unknown> {
  return request('/api/bot/resume', { method: 'POST', body: JSON.stringify({}) });
}

export async function cancelOrder(symbol: string): Promise<{ ok: boolean }> {
  return request('/api/orders/cancel', { method: 'POST', body: JSON.stringify({ symbol }) });
}

import type { BotSettings, BotState, BotStats, UniverseState } from './types';

const backendUrl = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';

export const API_BASE = backendUrl;
export const WS_URL = backendUrl.replace(/^http/, 'ws') + '/ws';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init
  });
  const body = await response.json();
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const getHealth = () => request<{ ok: boolean }>('/health');
export const getBotState = () => request<BotState>('/api/bot/state');
export const getBotStats = () => request<{ ok: true; stats: BotStats }>('/api/bot/stats');
export const startBot = (settings?: Partial<BotSettings>) => request('/api/bot/start', { method: 'POST', body: JSON.stringify(settings ?? {}) });
export const stopBot = () => request('/api/bot/stop', { method: 'POST', body: JSON.stringify({}) });
export const resetBot = () => request('/api/bot/reset', { method: 'POST', body: JSON.stringify({}) });

export const getBotConfig = () => request<{ ok: true; config: BotSettings }>('/api/bot/config');
export const saveBotConfig = (config: Partial<BotSettings>) => request<{ ok: true; config: BotSettings }>('/api/bot/config', { method: 'POST', body: JSON.stringify(config) });

export const getUniverse = () => request<UniverseState>('/api/universe');
export const createUniverse = (minVolPct: number, minTurnover: number) =>
  request('/api/universe/create', { method: 'POST', body: JSON.stringify({ minVolPct, minTurnover }) });
export const getUniverseConfig = () => request<{ ok: true; config: { minVolPct: number; minTurnover: number } }>('/api/universe/config');
export const saveUniverseConfig = (config: { minVolPct: number; minTurnover: number }) =>
  request<{ ok: true; config: { minVolPct: number; minTurnover: number } }>('/api/universe/config', { method: 'POST', body: JSON.stringify(config) });

export const getStatus = () =>
  request<{ ok: true; bybitWs: { connected: boolean; lastMessageAt: number | null; lastTickerAt: number | null; subscribedCount: number; desiredCount: number } }>('/api/status');

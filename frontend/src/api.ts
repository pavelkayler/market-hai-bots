import type { BotSettings, BotState, BotStats, DoctorResponse, JournalEntry, ProfilesState, ReplaySpeed, ReplayState, UniverseState } from './types';

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

export async function createUniverse(minVolPct: number, minTurnover: number): Promise<unknown> {
  return request('/api/universe/create', {
    method: 'POST',
    body: JSON.stringify({ minVolPct, minTurnover })
  });
}

export async function refreshUniverse(filters?: { minVolPct?: number; minTurnover?: number }): Promise<unknown> {
  return request('/api/universe/refresh', {
    method: 'POST',
    body: JSON.stringify(filters ?? {})
  });
}

export async function clearUniverse(): Promise<{ ok: boolean }> {
  return request('/api/universe/clear', { method: 'POST', body: JSON.stringify({}) });
}

export async function getBotState(): Promise<BotState> {
  return request('/api/bot/state');
}

export async function getBotStats(): Promise<{ ok: true; stats: BotStats }> {
  return request('/api/bot/stats');
}


export async function killBot(): Promise<{ ok: true; cancelled: number }> {
  return request('/api/bot/kill', { method: 'POST', body: JSON.stringify({}) });
}

export async function getBotGuardrails(): Promise<{ ok: true; guardrails: Pick<BotSettings, 'maxActiveSymbols' | 'dailyLossLimitUSDT' | 'maxConsecutiveLosses'> }> {
  return request('/api/bot/guardrails');
}

export async function resetBotStats(): Promise<{ ok: true }> {
  return request('/api/bot/stats/reset', { method: 'POST', body: JSON.stringify({}) });
}

export async function startBot(settings?: BotSettings | null): Promise<unknown> {
  return request('/api/bot/start', { method: 'POST', body: JSON.stringify(settings ?? null) });
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

export async function downloadUniverseJson(): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/universe/download`);
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new ApiRequestError(body.error ?? `HTTP ${response.status}`, body.error);
  }

  return response.blob();
}

export async function startRecording(topN: number, fileName: string): Promise<{ ok: boolean; path: string; startedAt: number }> {
  return request('/api/replay/record/start', {
    method: 'POST',
    body: JSON.stringify({ topN, fileName })
  });
}

export async function stopRecording(): Promise<{ ok: boolean; stoppedAt: number; recordsWritten: number }> {
  return request('/api/replay/record/stop', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function startReplay(fileName: string, speed: ReplaySpeed): Promise<{ ok: boolean; startedAt: number }> {
  return request('/api/replay/start', {
    method: 'POST',
    body: JSON.stringify({ fileName, speed })
  });
}

export async function stopReplay(): Promise<{ ok: boolean; stoppedAt: number }> {
  return request('/api/replay/stop', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function getReplayState(): Promise<ReplayState> {
  return request('/api/replay/state');
}

export async function getReplayFiles(): Promise<{ ok: boolean; files: string[] }> {
  return request('/api/replay/files');
}


export async function getJournalTail(limit: number): Promise<{ ok: boolean; entries: JournalEntry[] }> {
  return request(`/api/journal/tail?limit=${limit}`);
}

export async function clearJournal(): Promise<{ ok: boolean }> {
  return request('/api/journal/clear', { method: 'POST', body: JSON.stringify({}) });
}

export async function downloadJournal(format: 'ndjson' | 'json' | 'csv'): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/journal/download?format=${format}`);
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new ApiRequestError(body.error ?? `HTTP ${response.status}`, body.error);
  }

  return response.blob();
}


export async function downloadExportPack(): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/export/pack`);
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new ApiRequestError(body.error ?? `HTTP ${response.status}`, body.error);
  }

  return response.blob();
}

export async function getDoctor(): Promise<DoctorResponse> {
  return request('/api/doctor');
}

export async function getProfiles(): Promise<ProfilesState> {
  return request('/api/profiles');
}

export async function getProfile(name: string): Promise<{ ok: true; name: string; config: BotSettings }> {
  return request(`/api/profiles/${encodeURIComponent(name)}`);
}

export async function saveProfile(name: string, config: BotSettings): Promise<{ ok: boolean }> {
  return request(`/api/profiles/${encodeURIComponent(name)}`, {
    method: 'POST',
    body: JSON.stringify(config)
  });
}

export async function setActiveProfile(name: string): Promise<{ ok: boolean }> {
  return request(`/api/profiles/${encodeURIComponent(name)}/active`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function deleteProfile(name: string): Promise<{ ok: boolean }> {
  return request(`/api/profiles/${encodeURIComponent(name)}`, {
    method: 'DELETE'
  });
}

export async function downloadProfiles(): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/profiles/download`);
  if (!response.ok) {
    throw new ApiRequestError(`HTTP ${response.status}`);
  }

  return response.blob();
}

export async function uploadProfiles(rawJson: unknown): Promise<{ ok: boolean }> {
  return request('/api/profiles/upload', {
    method: 'POST',
    body: JSON.stringify(rawJson)
  });
}

import { request } from 'undici';

import { parseInstrumentsInfo } from '../bybit/parsers.js';

export type InstrumentLinear = {
  symbol: string;
  category?: string | null;
  contractType?: string | null;
  status?: string | null;
  settleCoin?: string | null;
  quoteCoin?: string | null;
  baseCoin?: string | null;
  deliveryTime?: string | null;
  qtyStep: number | null;
  minOrderQty: number | null;
  maxOrderQty: number | null;
};

export type TickerLinear = {
  symbol: string;
  turnover24hUSDT: number | null;
  turnover24h: number | null;
  highPrice24h: number | null;
  lowPrice24h: number | null;
  markPrice: number | null;
  openInterestValue: number | null;
  fundingRate?: number | null;
  nextFundingTime?: number | null;
};

export interface IBybitMarketClient {
  getInstrumentsLinearAll(): Promise<InstrumentLinear[]>;
  getTickersLinear(): Promise<Map<string, TickerLinear>>;
}

export type BybitApiErrorCode = 'TIMEOUT' | 'UNREACHABLE' | 'AUTH_ERROR' | 'RATE_LIMIT' | 'BAD_RESPONSE' | 'PARSE_ERROR';

export class BybitApiError extends Error {
  constructor(
    message: string,
    public readonly code: BybitApiErrorCode,
    public readonly retryable: boolean,
    public readonly statusCode?: number
  ) {
    super(message);
  }
}

type BybitListResponse = {
  retCode: number;
  retMsg: string;
  result?: {
    list?: unknown[];
    nextPageCursor?: string;
  };
};

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export class BybitMarketClient implements IBybitMarketClient {
  constructor(
    private readonly baseUrl = process.env.BYBIT_REST ?? 'https://api.bybit.com',
    private readonly timeoutMs = Number(process.env.UNIVERSE_UPSTREAM_TIMEOUT_MS ?? 8_000),
    private readonly maxRetries = Number(process.env.UNIVERSE_UPSTREAM_MAX_RETRIES ?? 2)
  ) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    const all: InstrumentLinear[] = [];
    let cursor = '';

    while (true) {
      const query = new URLSearchParams({ category: 'linear', limit: '1000' });
      if (cursor.length > 0) {
        query.set('cursor', cursor);
      }

      const json = await this.get<BybitListResponse>(`/v5/market/instruments-info?${query.toString()}`);
      if (json.retCode !== 0) {
        throw this.errorFromRetCode('Bybit instruments failed', json.retCode, json.retMsg);
      }

      all.push(...parseInstrumentsInfo(json));

      const nextCursor = json.result?.nextPageCursor ?? '';
      if (!nextCursor) {
        break;
      }

      cursor = nextCursor;
    }

    return all;
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    const query = new URLSearchParams({ category: 'linear' });
    const json = await this.get<BybitListResponse>(`/v5/market/tickers?${query.toString()}`);

    if (json.retCode !== 0) {
      throw this.errorFromRetCode('Bybit tickers failed', json.retCode, json.retMsg);
    }

    const map = new Map<string, TickerLinear>();

    for (const row of json.result?.list ?? []) {
      if (!row || typeof row !== 'object') {
        continue;
      }

      const symbol = typeof (row as { symbol?: unknown }).symbol === 'string' ? (row as { symbol: string }).symbol : null;
      if (!symbol) {
        continue;
      }

      map.set(symbol, {
        symbol,
        turnover24hUSDT:
          parseNumber((row as { turnover24h?: unknown }).turnover24h) ??
          parseNumber((row as { turnover24hValue?: unknown }).turnover24hValue),
        turnover24h:
          parseNumber((row as { turnover24h?: unknown }).turnover24h) ??
          parseNumber((row as { turnover24hValue?: unknown }).turnover24hValue),
        highPrice24h: parseNumber((row as { highPrice24h?: unknown }).highPrice24h),
        lowPrice24h: parseNumber((row as { lowPrice24h?: unknown }).lowPrice24h),
        markPrice: parseNumber((row as { markPrice?: unknown }).markPrice),
        openInterestValue: parseNumber((row as { openInterestValue?: unknown }).openInterestValue),
        fundingRate: parseNumber((row as { fundingRate?: unknown }).fundingRate),
        nextFundingTime: parseNumber((row as { nextFundingTime?: unknown }).nextFundingTime)
      });
    }

    return map;
  }

  private async get<T>(path: string): Promise<T> {
    const timeoutMs = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : 8_000;
    const maxRetries = Number.isFinite(this.maxRetries) && this.maxRetries >= 0 ? Math.floor(this.maxRetries) : 2;

    let attempt = 0;

    while (attempt <= maxRetries) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await request(`${this.baseUrl}${path}`, { method: 'GET', signal: controller.signal });

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = this.errorFromStatus(response.statusCode);
          if (!error.retryable || attempt >= maxRetries) {
            throw error;
          }
          attempt += 1;
          continue;
        }

        try {
          return (await response.body.json()) as T;
        } catch {
          const error = new BybitApiError('Bybit response parse error', 'PARSE_ERROR', false);
          throw error;
        }
      } catch (error) {
        const classified = this.classifyRequestError(error);
        if (!classified.retryable || attempt >= maxRetries) {
          throw classified;
        }
        attempt += 1;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new BybitApiError('Bybit unreachable after retries', 'UNREACHABLE', true);
  }

  private classifyRequestError(error: unknown): BybitApiError {
    if (error instanceof BybitApiError) {
      return error;
    }

    const cause = error as { name?: string; code?: string; message?: string };
    if (cause?.name === 'AbortError') {
      return new BybitApiError('Bybit request timeout', 'TIMEOUT', true);
    }

    if (cause?.code && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause.code)) {
      return new BybitApiError(`Bybit unreachable: ${cause.code}`, 'UNREACHABLE', true);
    }

    return new BybitApiError(cause?.message ?? 'Bybit request failed', 'BAD_RESPONSE', false);
  }

  private errorFromStatus(statusCode: number): BybitApiError {
    if (statusCode === 401 || statusCode === 403) {
      return new BybitApiError(`Bybit auth error: HTTP ${statusCode}`, 'AUTH_ERROR', false, statusCode);
    }

    if (statusCode === 429) {
      return new BybitApiError('Bybit rate limited: HTTP 429', 'RATE_LIMIT', true, statusCode);
    }

    const retryable = statusCode >= 500;
    return new BybitApiError(`Bybit request failed with status ${statusCode}`, 'BAD_RESPONSE', retryable, statusCode);
  }

  private errorFromRetCode(prefix: string, retCode: number, retMsg: string): BybitApiError {
    if (retCode === 10003 || retCode === 10005 || retCode === 10007) {
      return new BybitApiError(`${prefix}: ${retCode} ${retMsg}`, 'AUTH_ERROR', false);
    }

    if (retCode === 10006) {
      return new BybitApiError(`${prefix}: ${retCode} ${retMsg}`, 'RATE_LIMIT', true);
    }

    return new BybitApiError(`${prefix}: ${retCode} ${retMsg}`, 'BAD_RESPONSE', false);
  }
}

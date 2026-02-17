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
};

export interface IBybitMarketClient {
  getInstrumentsLinearAll(): Promise<InstrumentLinear[]>;
  getTickersLinear(): Promise<Map<string, TickerLinear>>;
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
  constructor(private readonly baseUrl = process.env.BYBIT_REST ?? 'https://api.bybit.com') {}

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
        throw new Error(`Bybit instruments failed: ${json.retCode} ${json.retMsg}`);
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
      throw new Error(`Bybit tickers failed: ${json.retCode} ${json.retMsg}`);
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
        openInterestValue: parseNumber((row as { openInterestValue?: unknown }).openInterestValue)
      });
    }

    return map;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await request(`${this.baseUrl}${path}`, { method: 'GET' });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Bybit request failed with status ${response.statusCode}`);
    }

    return response.body.json() as Promise<T>;
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from '../src/services/bybitMarketClient.js';
import { buildServer, getMarketHub } from '../src/server.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';

class FakeMarketClient implements IBybitMarketClient {
  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    return [
      { symbol: 'BTCUSDT', category: 'linear', contractType: 'LinearPerpetual', status: 'Trading', settleCoin: 'USDT', quoteCoin: 'USDT', baseCoin: 'BTC', deliveryTime: null },
      { symbol: 'ETHUSDT', category: 'linear', contractType: 'LinearPerpetual', status: 'Trading', settleCoin: 'USDT', quoteCoin: 'USDT', baseCoin: 'ETH', deliveryTime: null }
    ];
  }
  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    const now = Date.now();
    return new Map([
      ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 20_000_000, highPrice24h: 1, lowPrice24h: 1, fundingRate: 0.001, nextFundingTime: now + 60_000 }],
      ['ETHUSDT', { symbol: 'ETHUSDT', turnover24h: 20_000_000, highPrice24h: 1, lowPrice24h: 1, fundingRate: 0.002, nextFundingTime: now + 120_000 }]
    ]);
  }
  async getTickerLinear(symbol: string): Promise<TickerLinear | null> {
    return (await this.getTickersLinear()).get(symbol) ?? null;
  }
}

class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setSymbols(): Promise<void> {}
  onTicker(handler: (update: TickerUpdate) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  emit(update: TickerUpdate): void {
    this.handler?.(update);
  }
}

describe('funding nextFundingTimeMs is per symbol', () => {
  const ticker = new FakeTickerStream();
  const app = buildServer({
    marketClient: new FakeMarketClient(),
    tickerStream: ticker,
    universeFilePath: path.join(os.tmpdir(), `u-${Date.now()}.json`),
    runtimeSnapshotFilePath: path.join(os.tmpdir(), `r-${Date.now()}.json`)
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns distinct nextFundingTimeMs values per symbol in /api/bot/state', async () => {
    await app.ready();
    await getMarketHub(app).start();
    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1000 } });
    await app.inject({ method: 'POST', url: '/api/bot/start', payload: { mode: 'paper', direction: 'both', tf: 1, holdSeconds: 3, signalCounterThreshold: 2, priceUpThrPct: 0.5, oiUpThrPct: 10, oiCandleThrPct: 0, marginUSDT: 100, leverage: 10, tpRoiPct: 1, slRoiPct: 0.7, entryOffsetPct: 0 } });

    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });
    const body = response.json() as { symbols: Array<{ symbol: string; nextFundingTimeMs: number | null }> };
    const btc = body.symbols.find((row) => row.symbol === 'BTCUSDT');
    const eth = body.symbols.find((row) => row.symbol === 'ETHUSDT');

    expect(response.statusCode).toBe(200);
    expect(btc?.nextFundingTimeMs).not.toBeNull();
    expect(eth?.nextFundingTimeMs).not.toBeNull();
    expect(btc?.nextFundingTimeMs).not.toEqual(eth?.nextFundingTimeMs);
  });
});

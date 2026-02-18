import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';
import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from '../src/services/bybitMarketClient.js';

class FakeMarketClient implements IBybitMarketClient {
  constructor(
    private readonly instruments: InstrumentLinear[],
    private readonly tickers: Map<string, TickerLinear>
  ) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    return this.instruments.map((instrument) => ({
      category: instrument.category ?? 'linear',
      status: instrument.status ?? 'Trading',
      settleCoin: instrument.settleCoin ?? 'USDT',
      quoteCoin: instrument.quoteCoin ?? 'USDT',
      ...instrument
    }));
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    return this.tickers;
  }
}

class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async setSymbols(_symbols: string[]): Promise<void> {
    void _symbols;
  }

  onTicker(handler: (update: TickerUpdate) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
}

const buildIsolatedServer = (options: Parameters<typeof buildServer>[0] = {}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return buildServer({
    universeFilePath: options.universeFilePath ?? path.join(os.tmpdir(), `universe-contract-${suffix}.json`),
    runtimeSnapshotFilePath: options.runtimeSnapshotFilePath ?? path.join(os.tmpdir(), `runtime-contract-${suffix}.json`),
    journalFilePath: options.journalFilePath ?? path.join(os.tmpdir(), `journal-contract-${suffix}.ndjson`),
    profileFilePath: options.profileFilePath ?? path.join(os.tmpdir(), `profiles-contract-${suffix}.json`),
    universeExclusionsFilePath: options.universeExclusionsFilePath ?? path.join(os.tmpdir(), `universe-exclusions-contract-${suffix}.json`),
    ...options
  });
};

describe('route contract stability', () => {
  let app = buildIsolatedServer();

  afterEach(async () => {
    await app.close();
    app = buildIsolatedServer();
  });

  it('/api/bot/state returns frozen v2 contract with 0-safe values', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      bot: { phase: string; running: boolean; startedAt: number | null; stoppedAt: number | null; lastError: string | null };
      config: Record<string, unknown>;
      universe: { ready: boolean; symbolsCount: number; excludedCount: number };
      activity: Record<string, unknown>;
      symbols: Array<Record<string, unknown>>;
    };

    expect(body.bot.phase).toBe('STOPPED');
    expect(body.bot.running).toBe(false);
    expect(body.bot.startedAt).toBeNull();
    expect(body.bot.lastError).toBeNull();

    for (const field of ['tfMinutes', 'priceUpThrPct', 'oiUpThrPct', 'minTriggerCount', 'maxTriggerCount']) {
      expect(typeof body.config[field]).toBe('number');
      expect(Number.isFinite(body.config[field] as number)).toBe(true);
    }

    for (const field of ['queueDepth', 'activeOrders', 'openPositions', 'journalAgeMs', 'symbolUpdatesPerSec']) {
      expect(typeof body.activity[field]).toBe('number');
      expect(Number.isFinite(body.activity[field] as number)).toBe(true);
    }

    expect(body.universe.ready).toBe(false);
    expect(body.universe.symbolsCount).toBe(0);
    expect(body.universe.excludedCount).toBe(0);
    expect(Array.isArray(body.symbols)).toBe(true);
    expect(body.symbols).toHaveLength(0);
  });


  it('removed endpoints return 404', async () => {
    for (const url of ['/api/autotune/state', '/api/runs/summary', '/api/export/pack']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ ok: false, error: 'REMOVED_IN_V2' });
    }
  });
  it('/api/doctor returns checks[] with stable ids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { checks?: Array<{ id?: string }> };
    const ids = new Set((body.checks ?? []).map((check) => check.id));

    for (const id of [
      'ws_freshness',
      'market_age_per_symbol',
      'lifecycle_invariants',
      'universe_contract_filter'
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('/api/universe/exclusions/add remains STOP-only with 409 while running', async () => {
    await app.close();
    app = buildIsolatedServer({
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          [
            'BTCUSDT',
            {
              symbol: 'BTCUSDT',
              turnover24h: 20_000_000,
              highPrice24h: 102,
              lowPrice24h: 100,
              openInterest: 1,
              openInterestValue: 100
            }
          ]
        ])
      ),
      tickerStream: new FakeTickerStream()
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1 } });
    const start = await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'paper',
        direction: 'both',
        tf: 1,
        holdSeconds: 1,
        signalCounterThreshold: 1,
        priceUpThrPct: 0.1,
        oiUpThrPct: 0.1,
        oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0
      }
    });
    expect(start.statusCode).toBe(200);

    const response = await app.inject({ method: 'POST', url: '/api/universe/exclusions/add', payload: { symbol: 'BTCUSDT' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: 'BOT_RUNNING', message: 'Exclusions are STOP-only.' });
  });
});

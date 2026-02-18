import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import type { InstrumentLinear, IBybitMarketClient, TickerLinear } from '../src/services/bybitMarketClient.js';

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

const buildIsolatedServer = (options: Parameters<typeof buildServer>[0] = {}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return buildServer({
    universeFilePath: options.universeFilePath ?? path.join(os.tmpdir(), `universe-v2-contract-${suffix}.json`),
    runtimeSnapshotFilePath: options.runtimeSnapshotFilePath ?? path.join(os.tmpdir(), `runtime-v2-contract-${suffix}.json`),
    journalFilePath: options.journalFilePath ?? path.join(os.tmpdir(), `journal-v2-contract-${suffix}.ndjson`),
    profileFilePath: options.profileFilePath ?? path.join(os.tmpdir(), `profiles-v2-contract-${suffix}.json`),
    universeExclusionsFilePath:
      options.universeExclusionsFilePath ?? path.join(os.tmpdir(), `universe-exclusions-v2-contract-${suffix}.json`),
    ...options
  });
};

describe('v2 bot state contract and stop-only reset ops', () => {
  let app = buildIsolatedServer();

  afterEach(async () => {
    await app.close();
    app = buildIsolatedServer();
  });

  it('GET /api/bot/state includes v2 additive-safe contract sections', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      bot: {
        phase: 'STOPPED',
        running: false,
        startedAt: null,
        lastError: null
      },
      config: {
        tfMinutes: 0,
        priceUpThrPct: 0,
        oiUpThrPct: 0,
        minTriggerCount: 0,
        maxTriggerCount: 0
      },
      universe: {
        ready: false,
        symbolsCount: 0,
        excludedCount: 0
      },
      activity: {
        queueDepth: 0,
        activeOrders: 0,
        openPositions: 0,
        symbolUpdatesPerSec: 0
      },
      symbols: [],
      killInProgress: false,
      killCompletedAt: null,
      killWarning: null
    });
  });

  it('POST /api/bot/reset is STOP-only and returns BOT_RUNNING when started', async () => {
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
              markPrice: 100,
              openInterest: 1,
              openInterestValue: 100
            }
          ]
        ])
      )
    });

    const createUniverseResponse = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1 } });
    expect(createUniverseResponse.statusCode).toBe(200);

    const startResponse = await app.inject({
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
    expect(startResponse.statusCode).toBe(200);

    const resetResponse = await app.inject({ method: 'POST', url: '/api/bot/reset', payload: {} });
    expect(resetResponse.statusCode).toBe(409);
    expect(resetResponse.json()).toEqual({ ok: false, error: 'BOT_RUNNING', message: 'Reset is STOP-only.' });

    const clearAllResponse = await app.inject({ method: 'POST', url: '/api/bot/clearAllTables', payload: {} });
    expect(clearAllResponse.statusCode).toBe(409);
    expect(clearAllResponse.json()).toEqual({ ok: false, error: 'BOT_RUNNING', message: 'Reset all is STOP-only.' });
  });
});

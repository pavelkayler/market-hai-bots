import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';
import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from '../src/services/bybitMarketClient.js';
import { ActiveSymbolSet } from '../src/services/universeService.js';

class FakeMarketClient implements IBybitMarketClient {
  constructor(
    private readonly instruments: InstrumentLinear[],
    private readonly tickers: Map<string, TickerLinear>
  ) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    return this.instruments;
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    return this.tickers;
  }
}

describe('server routes', () => {
  let app = buildServer();

  afterEach(async () => {
    await app.close();
    app = buildServer();
  });

  it('GET /health returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('GET /api/bot/state returns initial bot state', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      running: false,
      mode: null,
      direction: null,
      tf: null,
      queueDepth: 0,
      activeOrders: 0,
      openPositions: 0,
      startedAt: null
    });
  });


  it('POST /api/bot/start returns UNIVERSE_NOT_READY when universe does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'paper',
        direction: 'long',
        tf: 1,
        holdSeconds: 1,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'UNIVERSE_NOT_READY' });
  });


  it('universe create/get/refresh/clear persists and reloads state', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-test-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');

    const marketClient = new FakeMarketClient(
      [
        { symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 },
        { symbol: 'ETHUSDT', qtyStep: 0.01, minOrderQty: 0.01, maxOrderQty: 1000 },
        { symbol: 'XRPUSDT', qtyStep: 1, minOrderQty: 1, maxOrderQty: 100000 }
      ],
      new Map<string, TickerLinear>([
        [
          'BTCUSDT',
          {
            symbol: 'BTCUSDT',
            turnover24h: 12000000,
            highPrice24h: 110,
            lowPrice24h: 100,
            markPrice: 105,
            openInterestValue: 200000
          }
        ],
        [
          'ETHUSDT',
          {
            symbol: 'ETHUSDT',
            turnover24h: 9000000,
            highPrice24h: 105,
            lowPrice24h: 100,
            markPrice: 101,
            openInterestValue: 100000
          }
        ],
        [
          'XRPUSDT',
          {
            symbol: 'XRPUSDT',
            turnover24h: 15000000,
            highPrice24h: 101,
            lowPrice24h: 100,
            markPrice: 100.5,
            openInterestValue: 50000
          }
        ]
      ])
    );

    const activeSymbols = new ActiveSymbolSet();
    activeSymbols.add('ETHUSDT');

    app = buildServer({ marketClient, universeFilePath, activeSymbolSet: activeSymbols });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/universe/create',
      payload: { minVolPct: 5 }
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 10000000, minVolPct: 5 },
      totalFetched: 3,
      passed: 1,
      forcedActive: 0
    });

    const fileContent = JSON.parse(await readFile(universeFilePath, 'utf-8')) as {
      symbols: Array<{ symbol: string }>;
      ready: boolean;
    };
    expect(fileContent.ready).toBe(true);
    expect(fileContent.symbols.map((entry) => entry.symbol)).toEqual(['BTCUSDT']);

    const getResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      ok: true,
      ready: true,
      filters: { minTurnover: 10000000, minVolPct: 5 }
    });

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/universe/refresh',
      payload: {}
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 10000000, minVolPct: 5 },
      passed: 2,
      forcedActive: 1
    });

    const refreshedStateResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    const refreshedState = refreshedStateResponse.json() as {
      symbols: Array<{ symbol: string; forcedActive: boolean }>;
    };
    expect(refreshedState.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'BTCUSDT', forcedActive: false }),
        expect.objectContaining({ symbol: 'ETHUSDT', forcedActive: true })
      ])
    );

    const clearResponse = await app.inject({ method: 'POST', url: '/api/universe/clear' });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ ok: true });

    const getAfterClear = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(getAfterClear.json()).toEqual({ ok: false, ready: false });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('refresh returns UNIVERSE_NOT_READY without prior create or persisted universe', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-test-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');

    app = buildServer({
      marketClient: new FakeMarketClient([], new Map()),
      universeFilePath
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/universe/refresh',
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'UNIVERSE_NOT_READY' });

    await rm(tempDir, { recursive: true, force: true });
  });
});

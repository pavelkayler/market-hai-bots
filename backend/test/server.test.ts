import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IDemoTradeClient } from '../src/bybit/demoTradeClient.js';
import { buildServer } from '../src/server.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';
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


class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;
  public readonly setSymbolsCalls: string[][] = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async setSymbols(symbols: string[]): Promise<void> {
    this.setSymbolsCalls.push([...symbols]);
  }

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


class BlockingDemoTradeClient implements IDemoTradeClient {
  async createLimitOrderWithTpSl(): Promise<{ orderId: string; orderLinkId: string }> {
    await new Promise(() => undefined);
    return { orderId: '', orderLinkId: '' };
  }

  async cancelOrder(): Promise<void> {}

  async getOpenOrders(): Promise<[]> {
    return [];
  }
}

const buildIsolatedServer = (options: Parameters<typeof buildServer>[0] = {}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return buildServer({
    universeFilePath: options.universeFilePath ?? path.join(os.tmpdir(), `universe-${suffix}.json`),
    runtimeSnapshotFilePath: options.runtimeSnapshotFilePath ?? path.join(os.tmpdir(), `runtime-${suffix}.json`),
    journalFilePath: options.journalFilePath ?? path.join(os.tmpdir(), `journal-${suffix}.ndjson`),
    ...options
  });
};

describe('server routes', () => {
  let app = buildIsolatedServer();

  afterEach(async () => {
    await app.close();
    app = buildIsolatedServer();
  });

  it('GET /health returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });


  it('GET /api/journal/download?format=csv returns header and rows', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'journal-route-test-'));
    const journalFilePath = path.join(tempDir, 'journal.ndjson');
    await app.close();
    app = buildIsolatedServer({ journalFilePath });

    await writeFile(
      journalFilePath,
      `${JSON.stringify({
        ts: 1,
        mode: 'paper',
        symbol: 'BTCUSDT',
        event: 'ORDER_PLACED',
        side: 'LONG',
        data: { qty: 1.5, limitPrice: 100 }
      })}\n`,
      'utf-8'
    );

    const response = await app.inject({ method: 'GET', url: '/api/journal/download?format=csv' });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('ts,mode,symbol,event,side,qty,price,exitPrice,pnlUSDT,detailsJson');
    expect(body).toContain('BTCUSDT,ORDER_PLACED,LONG,1.5,100');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/bot/state returns initial bot state', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      running: false,
      paused: false,
      hasSnapshot: false,
      lastConfig: null,
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



  it('GET /api/doctor returns diagnostics shape without secrets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/doctor' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown> & {
      market: { tickHandlersMsAvg: number; wsClients: number; wsFramesPerSec: number };
      bot: { evalsPerSec: number };
    };
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty('serverTime');
    expect(body).toHaveProperty('uptimeSec');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('universe');
    expect(body).toHaveProperty('market');
    expect(body).toHaveProperty('bot');
    expect(body).toHaveProperty('replay');
    expect(body).toHaveProperty('journal');
    expect(body).toHaveProperty('demo');
    expect(body.market.tickHandlersMsAvg).toBeGreaterThanOrEqual(0);
    expect(body.market.wsClients).toBeGreaterThanOrEqual(0);
    expect(body.market.wsFramesPerSec).toBeGreaterThanOrEqual(0);
    expect(body.bot.evalsPerSec).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(body)).not.toContain('DEMO_API_SECRET');
  });

  it('POST /api/bot/start returns DEMO_NOT_CONFIGURED for demo mode without env keys', async () => {
    const prevKey = process.env.DEMO_API_KEY;
    const prevSecret = process.env.DEMO_API_SECRET;
    delete process.env.DEMO_API_KEY;
    delete process.env.DEMO_API_SECRET;

    try {
      app = buildIsolatedServer({
        marketClient: new FakeMarketClient(
          [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
          new Map([
            [
              'BTCUSDT',
              {
                symbol: 'BTCUSDT',
                turnover24h: 12000000,
                highPrice24h: 110,
                lowPrice24h: 100,
                markPrice: 100,
                openInterestValue: 100000
              }
            ]
          ])
        )
      });

      await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });

      const response = await app.inject({
        method: 'POST',
        url: '/api/bot/start',
        payload: {
          mode: 'demo',
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
      expect(response.json()).toEqual({
        ok: false,
        error: {
          code: 'DEMO_NOT_CONFIGURED',
          message: 'Demo mode requires DEMO_API_KEY and DEMO_API_SECRET.'
        }
      });
    } finally {
      if (prevKey === undefined) {
        delete process.env.DEMO_API_KEY;
      } else {
        process.env.DEMO_API_KEY = prevKey;
      }

      if (prevSecret === undefined) {
        delete process.env.DEMO_API_SECRET;
      } else {
        process.env.DEMO_API_SECRET = prevSecret;
      }
    }
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

    app = buildIsolatedServer({ marketClient, universeFilePath, activeSymbolSet: activeSymbols });

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

    app = buildIsolatedServer({
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

  it('GET /api/universe/download returns persisted universe payload when ready', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-download-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');

    app = buildIsolatedServer({
      universeFilePath,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
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
          ]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 5 } });

    const response = await app.inject({ method: 'GET', url: '/api/universe/download' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      ready: true,
      symbols: [expect.objectContaining({ symbol: 'BTCUSDT' })]
    });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/universe/download returns UNIVERSE_NOT_READY when missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/universe/download' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'UNIVERSE_NOT_READY' });
  });


  it('universe create wires market symbols once and clear resets symbol update throttle', async () => {
    const tickerStream = new FakeTickerStream();
    const wsMessages: string[] = [];
    const wsClients = new Set([{ send: (payload: string) => wsMessages.push(payload) }]);

    app = buildIsolatedServer({
      tickerStream,
      wsClients,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          [
            'BTCUSDT',
            {
              symbol: 'BTCUSDT',
              turnover24h: 12000000,
              highPrice24h: 110,
              lowPrice24h: 100,
              markPrice: 100,
              openInterestValue: 100000
            }
          ]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });

    expect(tickerStream.setSymbolsCalls).toEqual([[], ['BTCUSDT']]);

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 2000, ts: Date.now() });
    const firstSymbolUpdateCount = wsMessages.filter((raw) => JSON.parse(raw).type === 'symbol:update').length;
    expect(firstSymbolUpdateCount).toBe(1);

    await app.inject({ method: 'POST', url: '/api/universe/clear' });
    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 101, openInterestValue: 2001, ts: Date.now() });
    const secondSymbolUpdateCount = wsMessages.filter((raw) => JSON.parse(raw).type === 'symbol:update').length;
    expect(secondSymbolUpdateCount).toBe(2);
  });

  it('POST /api/orders/cancel cancels pending paper order and returns ok', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const tickerStream = new FakeTickerStream();
    app = buildIsolatedServer({
      now: () => now,
      tickerStream,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          [
            'BTCUSDT',
            {
              symbol: 'BTCUSDT',
              turnover24h: 12000000,
              highPrice24h: 110,
              lowPrice24h: 100,
              markPrice: 100,
              openInterestValue: 100000
            }
          ]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({
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

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 103, openInterestValue: 1030, ts: now });

    const cancelResponse = await app.inject({ method: 'POST', url: '/api/orders/cancel', payload: { symbol: 'BTCUSDT' } });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({ ok: true });

    const botState = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(botState.json()).toMatchObject({ activeOrders: 0, openPositions: 0 });
  });

  it('GET /api/bot/state reflects demo queueDepth', async () => {
    const prevKey = process.env.DEMO_API_KEY;
    const prevSecret = process.env.DEMO_API_SECRET;
    process.env.DEMO_API_KEY = 'demo-key';
    process.env.DEMO_API_SECRET = 'demo-secret';

    try {
      let now = Date.UTC(2025, 0, 1, 0, 0, 0);
      const tickerStream = new FakeTickerStream();
      app = buildIsolatedServer({
      now: () => now,
      tickerStream,
      demoTradeClient: new BlockingDemoTradeClient(),
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          [
            'BTCUSDT',
            {
              symbol: 'BTCUSDT',
              turnover24h: 12000000,
              highPrice24h: 110,
              lowPrice24h: 100,
              markPrice: 100,
              openInterestValue: 100000
            }
          ]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'demo',
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

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 103, openInterestValue: 1030, ts: now });

      const response = await app.inject({ method: 'GET', url: '/api/bot/state' });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { queueDepth: number }).queueDepth).toBeGreaterThan(0);
    } finally {
      if (prevKey === undefined) {
        delete process.env.DEMO_API_KEY;
      } else {
        process.env.DEMO_API_KEY = prevKey;
      }

      if (prevSecret === undefined) {
        delete process.env.DEMO_API_SECRET;
      } else {
        process.env.DEMO_API_SECRET = prevSecret;
      }
    }
  });




  it('universe clear removes runtime snapshot and state hasSnapshot=false', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'runtime-test-'));
    const runtimeSnapshotFilePath = path.join(tempDir, 'data', 'runtime.json');
    await mkdir(path.dirname(runtimeSnapshotFilePath), { recursive: true });
    await writeFile(
      runtimeSnapshotFilePath,
      JSON.stringify({ savedAt: Date.now(), paused: true, running: true, config: null, symbols: {} }),
      'utf-8'
    );

    app = buildIsolatedServer({ runtimeSnapshotFilePath });
    const clearResponse = await app.inject({ method: 'POST', url: '/api/universe/clear' });
    expect(clearResponse.statusCode).toBe(200);

    const stateResponse = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(stateResponse.json()).toMatchObject({ hasSnapshot: false });

    await expect(access(runtimeSnapshotFilePath)).rejects.toBeTruthy();
    await rm(tempDir, { recursive: true, force: true });
  });
});

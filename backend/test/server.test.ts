import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import JSZip from 'jszip';
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
    profileFilePath: options.profileFilePath ?? path.join(os.tmpdir(), `profiles-${suffix}.json`),
    universeExclusionsFilePath: options.universeExclusionsFilePath ?? path.join(os.tmpdir(), `universe-exclusions-${suffix}.json`),
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

  it('GET /api/profiles returns list with active profile', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/profiles' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      activeProfile: 'default',
      names: ['default']
    });
  });

  it('POST /api/profiles/:name/active sets active profile', async () => {
    const config = {
      mode: 'paper',
      direction: 'both',
      tf: 1,
      holdSeconds: 3,
  signalCounterThreshold: 2,
      priceUpThrPct: 0.5,
      oiUpThrPct: 50,
  oiCandleThrPct: 0,
      marginUSDT: 100,
      leverage: 10,
      tpRoiPct: 1,
      slRoiPct: 0.7,
      entryOffsetPct: 0
    };

    const saveResponse = await app.inject({
      method: 'POST',
      url: '/api/profiles/test1',
      payload: config
    });
    expect(saveResponse.statusCode).toBe(200);

    const activeResponse = await app.inject({
      method: 'POST',
      url: '/api/profiles/test1/active',
      payload: {}
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toEqual({ ok: true });

    const listResponse = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      ok: true,
      activeProfile: 'test1'
    });
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



  it('GET /api/journal/tail returns last N entries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'journal-tail-route-test-'));
    const journalFilePath = path.join(tempDir, 'journal.ndjson');
    await app.close();
    app = buildIsolatedServer({ journalFilePath });

    await writeFile(
      journalFilePath,
      [
        { ts: 1, mode: 'paper', symbol: 'BTCUSDT', event: 'SIGNAL', side: 'LONG', data: {} },
        { ts: 2, mode: 'paper', symbol: 'ETHUSDT', event: 'ORDER_PLACED', side: 'SHORT', data: {} },
        { ts: 3, mode: 'paper', symbol: 'SOLUSDT', event: 'POSITION_OPENED', side: 'LONG', data: {} }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf-8'
    );

    const response = await app.inject({ method: 'GET', url: '/api/journal/tail?limit=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      entries: [
        { ts: 2, mode: 'paper', symbol: 'ETHUSDT', event: 'ORDER_PLACED', side: 'SHORT', data: {} },
        { ts: 3, mode: 'paper', symbol: 'SOLUSDT', event: 'POSITION_OPENED', side: 'LONG', data: {} }
      ]
    });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/export/pack returns zip containing expected files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'export-pack-route-test-'));
    const universeFilePath = path.join(tempDir, 'universe.json');
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');
    const profileFilePath = path.join(tempDir, 'profiles.json');
    const journalFilePath = path.join(tempDir, 'journal.ndjson');

    await writeFile(universeFilePath, '{"ready":true}', 'utf-8');
    await writeFile(runtimeSnapshotFilePath, '{"running":false}', 'utf-8');
    await writeFile(profileFilePath, '{"activeProfile":"default"}', 'utf-8');
    await writeFile(journalFilePath, '{"ts":1}\n', 'utf-8');

    await app.close();
    app = buildIsolatedServer({ universeFilePath, runtimeSnapshotFilePath, profileFilePath, journalFilePath });

    const response = await app.inject({ method: 'GET', url: '/api/export/pack' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');

    const zip = await JSZip.loadAsync(response.rawPayload);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['journal.ndjson', 'meta.json', 'profiles.json', 'runtime.json', 'universe.json']);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/bot/guardrails returns defaults before start', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/guardrails' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      guardrails: {
        maxActiveSymbols: 5,
        dailyLossLimitUSDT: 0,
        maxConsecutiveLosses: 0
      }
    });
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
      startedAt: null,
      uptimeMs: 0
    });
  });


  it('GET /api/bot/stats returns defaults and reset returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/stats' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winratePct: 0,
        pnlUSDT: 0,
        avgWinUSDT: null,
        avgLossUSDT: null,
        lossStreak: 0,
        todayPnlUSDT: 0,
        guardrailPauseReason: null,
        long: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
        short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 }
      }
    });

    const resetResponse = await app.inject({ method: 'POST', url: '/api/bot/stats/reset', payload: {} });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({ ok: true });
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
  signalCounterThreshold: 2,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
  oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0
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
  signalCounterThreshold: 2,
          priceUpThrPct: 1,
          oiUpThrPct: 1,
  oiCandleThrPct: 0,
          marginUSDT: 100,
          leverage: 2,
          tpRoiPct: 1,
          slRoiPct: 1,
          entryOffsetPct: 0
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
      payload: { minVolPct: 5, minTurnover: 20000000 }
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 20000000, minVolPct: 5 },
      totalFetched: 3,
      passed: 0,
      forcedActive: 0
    });

    const fileContent = JSON.parse(await readFile(universeFilePath, 'utf-8')) as {
      symbols: Array<{ symbol: string }>;
      ready: boolean;
    };
    expect(fileContent.ready).toBe(true);
    expect(fileContent.symbols.map((entry) => entry.symbol)).toEqual([]);

    const getResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      ok: true,
      ready: true,
      filters: { minTurnover: 20000000, minVolPct: 5 }
    });

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/universe/refresh',
      payload: {}
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 20000000, minVolPct: 5 },
      passed: 1,
      forcedActive: 1
    });

    const refreshedStateResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    const refreshedState = refreshedStateResponse.json() as {
      symbols: Array<{ symbol: string; forcedActive: boolean }>;
    };
    expect(refreshedState.symbols).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'ETHUSDT', forcedActive: true })]));

    const refreshWithNewTurnover = await app.inject({
      method: 'POST',
      url: '/api/universe/refresh',
      payload: { minTurnover: 10000000 }
    });
    expect(refreshWithNewTurnover.statusCode).toBe(200);
    expect(refreshWithNewTurnover.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 10000000, minVolPct: 5 },
      passed: 2,
      forcedActive: 1
    });

    const refreshedWithNewTurnoverState = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(refreshedWithNewTurnoverState.json()).toMatchObject({
      ok: true,
      filters: { minTurnover: 10000000, minVolPct: 5 }
    });

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



  it('universe create includes only USDT linear perpetual symbols', async () => {
    const tickerStream = new FakeTickerStream();
    app = buildIsolatedServer({
      tickerStream,
      marketClient: new FakeMarketClient(
        [
          {
            symbol: 'BTCUSDT',
            category: 'linear',
            contractType: 'PERPETUAL',
            status: 'Trading',
            quoteCoin: 'USDT',
            settleCoin: 'USDT',
            baseCoin: 'BTC',
            qtyStep: 0.001,
            minOrderQty: 0.001,
            maxOrderQty: 100
          },
          {
            symbol: 'BTCUSDT-26JUN26',
            category: 'linear',
            contractType: 'FUTURES',
            status: 'Trading',
            quoteCoin: 'USDT',
            settleCoin: 'USDT',
            baseCoin: 'BTC',
            qtyStep: 0.001,
            minOrderQty: 0.001,
            maxOrderQty: 100
          }
        ],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }],
          ['BTCUSDT-26JUN26', { symbol: 'BTCUSDT-26JUN26', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ])
      )
    });

    const createResponse = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      passed: 1,
      contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY',
      filteredOut: { expiringOrNonPerp: 1 }
    });
    expect(tickerStream.setSymbolsCalls).toEqual([[], ['BTCUSDT']]);
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


  it('universe excludes expiring futures from persisted load and market subscriptions', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-contract-filter-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');
    await mkdir(path.dirname(universeFilePath), { recursive: true });
    await writeFile(
      universeFilePath,
      JSON.stringify(
        {
          createdAt: Date.now(),
          ready: true,
          filters: { minTurnover: 10000000, minVolPct: 5 },
          symbols: [
            {
              symbol: 'BTCUSDT',
              turnover24h: 12000000,
              highPrice24h: 110,
              lowPrice24h: 100,
              vol24hPct: 10,
              forcedActive: false,
              qtyStep: 0.001,
              minOrderQty: 0.001,
              maxOrderQty: 100
            },
            {
              symbol: 'BTCUSDT-26JUN26',
              turnover24h: 12000000,
              highPrice24h: 110,
              lowPrice24h: 100,
              vol24hPct: 10,
              forcedActive: false,
              qtyStep: 0.001,
              minOrderQty: 0.001,
              maxOrderQty: 100
            }
          ]
        },
        null,
        2
      ),
      'utf-8'
    );

    const tickerStream = new FakeTickerStream();
    await app.close();
    app = buildIsolatedServer({
      tickerStream,
      universeFilePath,
      marketClient: new FakeMarketClient(
        [
          {
            symbol: 'BTCUSDT',
            category: 'linear',
            contractType: 'PERPETUAL',
            status: 'Trading',
            quoteCoin: 'USDT',
            settleCoin: 'USDT',
            baseCoin: 'BTC',
            qtyStep: 0.001,
            minOrderQty: 0.001,
            maxOrderQty: 100
          },
          {
            symbol: 'BTCUSDT-26JUN26',
            category: 'linear',
            contractType: 'FUTURES',
            status: 'Trading',
            quoteCoin: 'USDT',
            settleCoin: 'USDT',
            baseCoin: 'BTC',
            qtyStep: 0.001,
            minOrderQty: 0.001,
            maxOrderQty: 100
          }
        ],
        new Map()
      )
    });

    await app.ready();

    expect(tickerStream.setSymbolsCalls).toEqual([['BTCUSDT']]);

    const universeResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(universeResponse.statusCode).toBe(200);
    expect(universeResponse.json()).toMatchObject({
      ok: true,
      symbols: [expect.objectContaining({ symbol: 'BTCUSDT' })],
      contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY',
      filteredOut: { expiringOrNonPerp: 1 }
    });

    await rm(tempDir, { recursive: true, force: true });
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
  signalCounterThreshold: 2,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
  oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0
      }
    });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 103, openInterestValue: 1030, ts: now });

    const cancelResponse = await app.inject({ method: 'POST', url: '/api/orders/cancel', payload: { symbol: 'BTCUSDT' } });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toEqual({ ok: true });

    const botState = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(botState.json()).toMatchObject({ activeOrders: 0, openPositions: 0 });
  });


  it('/api/bot/kill cancels all pending orders and leaves positions intact', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const tickerStream = new FakeTickerStream();
    app = buildIsolatedServer({
      now: () => now,
      tickerStream,
      marketClient: new FakeMarketClient(
        [
          { symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 },
          { symbol: 'ETHUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }
        ],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }],
          ['ETHUSDT', { symbol: 'ETHUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
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
  signalCounterThreshold: 2,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
  oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0
      }
    });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    tickerStream.emit({ symbol: 'ETHUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    tickerStream.emit({ symbol: 'ETHUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 103, openInterestValue: 1030, ts: now });
    tickerStream.emit({ symbol: 'ETHUSDT', markPrice: 103, openInterestValue: 1030, ts: now });

    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 103, openInterestValue: 1030, ts: now });

    const beforeKill = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(beforeKill.json()).toMatchObject({ activeOrders: 1, openPositions: 1 });

    const killResponse = await app.inject({ method: 'POST', url: '/api/bot/kill', payload: {} });
    expect(killResponse.statusCode).toBe(200);
    expect(killResponse.json()).toEqual({ ok: true, cancelled: 1 });

    const afterKill = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(afterKill.json()).toMatchObject({ paused: true, activeOrders: 0, openPositions: 1 });
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
  signalCounterThreshold: 2,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
  oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0
      }
    });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
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

  it('GET /api/bot/state activity metrics stay numeric with maxActiveSymbols=9999', async () => {
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
        signalCounterThreshold: 1,
        priceUpThrPct: 1,
        oiUpThrPct: 1,
        oiCandleThrPct: 0,
        marginUSDT: 100,
        leverage: 2,
        tpRoiPct: 1,
        slRoiPct: 1,
        entryOffsetPct: 0,
        maxActiveSymbols: 9999
      }
    });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });

    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });
    const payload = response.json() as { queueDepth: number; activeOrders: number; openPositions: number };

    expect(response.statusCode).toBe(200);
    expect(typeof payload.queueDepth).toBe('number');
    expect(typeof payload.activeOrders).toBe('number');
    expect(typeof payload.openPositions).toBe('number');
    expect(payload.activeOrders).toBe(1);
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

describe('universe exclusions routes', () => {
  let app = buildIsolatedServer();

  afterEach(async () => {
    await app.close();
    app = buildIsolatedServer();
  });

  it('rejects exclusion updates while bot is running', async () => {
    const marketClient: IBybitMarketClient = {
      async getInstrumentsLinearAll() {
        return [{ symbol: 'BTCUSDT', contractType: 'Perpetual', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 }];
      },
      async getTickersLinear() {
        return new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ]);
      }
    };

    await app.close();
    app = buildIsolatedServer({ marketClient });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({ method: 'POST', url: '/api/bot/start', payload: {
      mode: 'paper', direction: 'long', tf: 1, holdSeconds: 1, signalCounterThreshold: 1,
      priceUpThrPct: 0.5, oiUpThrPct: 1, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2, tpRoiPct: 1, slRoiPct: 1,
      entryOffsetPct: 0, maxActiveSymbols: 5, dailyLossLimitUSDT: 0, maxConsecutiveLosses: 0
    } });

    const response = await app.inject({ method: 'POST', url: '/api/universe/exclusions/add', payload: { symbol: 'BTCUSDT' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'BOT_RUNNING' });
  });

  it('filters excluded symbols from ticker subscriptions and create clears exclusions', async () => {
    const tickerStream = new FakeTickerStream();
    const marketClient: IBybitMarketClient = {
      async getInstrumentsLinearAll() {
        return [
          { symbol: 'BTCUSDT', contractType: 'Perpetual', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 },
          { symbol: 'ETHUSDT', contractType: 'Perpetual', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 }
        ];
      },
      async getTickersLinear() {
        return new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 13000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }],
          ['ETHUSDT', { symbol: 'ETHUSDT', turnover24h: 12000000, highPrice24h: 210, lowPrice24h: 200, markPrice: 200, openInterestValue: 200000 }]
        ]);
      }
    };

    await app.close();
    app = buildIsolatedServer({ marketClient, tickerStream });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    const exclude = await app.inject({ method: 'POST', url: '/api/universe/exclusions/add', payload: { symbol: 'BTCUSDT' } });
    expect(exclude.statusCode).toBe(200);

    const lastCall = tickerStream.setSymbolsCalls[tickerStream.setSymbolsCalls.length - 1] ?? [];
    expect(lastCall).toEqual(['ETHUSDT']);

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    const exclusionsAfterCreate = await app.inject({ method: 'GET', url: '/api/universe/exclusions' });
    expect(exclusionsAfterCreate.json()).toEqual({ ok: true, excluded: [] });
  });
});

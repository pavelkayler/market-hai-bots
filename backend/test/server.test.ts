import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import JSZip from 'jszip';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IDemoTradeClient } from '../src/bybit/demoTradeClient.js';
import { buildServer } from '../src/server.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';
import { BybitApiError, type IBybitMarketClient, type InstrumentLinear, type TickerLinear } from '../src/services/bybitMarketClient.js';
import { JournalService } from '../src/services/journalService.js';
import { ActiveSymbolSet } from '../src/services/universeService.js';

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

class FailingMarketClient implements IBybitMarketClient {
  constructor(private readonly error: Error) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    throw this.error;
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    throw this.error;
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
    vi.restoreAllMocks();
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
      names: ['default', 'fast_test_1m', 'overnight_1m_safe', 'smoke_min_1m']
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



  it('ops endpoints remain successful when SYSTEM journal append fails (best-effort)', async () => {
    const appendSpy = vi.spyOn(JournalService.prototype, 'append').mockImplementation(async (entry) => {
      if (entry.symbol === 'SYSTEM') {
        throw new Error('journal write failed');
      }
    });

    app = buildIsolatedServer({
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 105, openInterestValue: 200000 }]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 3 } });
    const startResponse = await app.inject({ method: 'POST', url: '/api/bot/start', payload: null });
    expect(startResponse.statusCode).toBe(200);

    const pauseResponse = await app.inject({ method: 'POST', url: '/api/bot/pause', payload: {} });
    expect(pauseResponse.statusCode).toBe(200);

    const resumeResponse = await app.inject({ method: 'POST', url: '/api/bot/resume', payload: {} });
    expect(resumeResponse.statusCode).toBe(200);

    const killResponse = await app.inject({ method: 'POST', url: '/api/bot/kill', payload: {} });
    expect(killResponse.statusCode).toBe(200);

    const exportResponse = await app.inject({ method: 'GET', url: '/api/export/pack' });
    expect(exportResponse.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(exportResponse.rawPayload);
    expect(Object.keys(zip.files)).toContain('meta.json');

    const stopResponse = await app.inject({ method: 'POST', url: '/api/bot/stop', payload: {} });
    expect(stopResponse.statusCode).toBe(200);

    const resetResponse = await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} });
    expect(resetResponse.statusCode).toBe(200);

    expect(appendSpy).toHaveBeenCalled();
  });

  it('GET /api/export/pack returns zip containing expected files and meta contract', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'export-pack-route-test-'));
    const universeFilePath = path.join(tempDir, 'universe.json');
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');
    const profileFilePath = path.join(tempDir, 'profiles.json');
    const journalFilePath = path.join(tempDir, 'journal.ndjson');

    await writeFile(universeFilePath, JSON.stringify({ ready: true, symbols: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }] }), 'utf-8');
    await writeFile(runtimeSnapshotFilePath, JSON.stringify({ savedAt: Date.now(), paused: true, running: true, config: null, symbols: {} }), 'utf-8');
    await writeFile(profileFilePath, JSON.stringify({ activeProfile: 'default', names: ['default', 'fast_test_1m'] }), 'utf-8');
    await writeFile(journalFilePath, '{"ts":1}\n{"ts":2}\n', 'utf-8');

    await app.close();
    app = buildIsolatedServer({ universeFilePath, runtimeSnapshotFilePath, profileFilePath, journalFilePath });
    await writeFile(runtimeSnapshotFilePath, JSON.stringify({ savedAt: Date.now(), paused: true, running: true, config: null, symbols: { BTCUSDT: {} } }), 'utf-8');

    const response = await app.inject({ method: 'GET', url: '/api/export/pack' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment; filename="export-pack_');
    expect(response.headers['x-export-included']).toBe('universe.json,profiles.json,runtime.json,journal.ndjson,meta.json');

    const zip = await JSZip.loadAsync(response.rawPayload);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['journal.ndjson', 'meta.json', 'profiles.json', 'runtime.json', 'universe.json']);

    const metaRaw = await zip.file('meta.json')?.async('string');
    const meta = JSON.parse(metaRaw ?? '{}') as {
      createdAt: number;
      appVersion: string;
      notes: string[];
      paths: Record<string, string>;
      counts: { journalLines: number; universeSymbols: number; profilesCount: number };
    };
    expect(typeof meta.createdAt).toBe('number');
    expect(typeof meta.appVersion).toBe('string');
    expect(meta.notes).toEqual([]);
    expect(meta.paths.universe).toBe(universeFilePath);
    expect(meta.paths.runtime).toBe(runtimeSnapshotFilePath);
    expect(meta.paths.profiles).toBe(profileFilePath);
    expect(meta.paths.journal).toBe(journalFilePath);
    expect(meta.counts).toMatchObject({ journalLines: 3, universeSymbols: 2, profilesCount: 2 });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/export/pack includes meta notes when runtime and journal are missing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'export-pack-missing-route-test-'));
    const universeFilePath = path.join(tempDir, 'universe.json');
    const profileFilePath = path.join(tempDir, 'profiles.json');
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');
    const journalFilePath = path.join(tempDir, 'journal.ndjson');

    await writeFile(universeFilePath, '{"ready":true,"symbols":[]}', 'utf-8');
    await writeFile(profileFilePath, '{"activeProfile":"default","names":["default"]}', 'utf-8');

    await app.close();
    app = buildIsolatedServer({ universeFilePath, runtimeSnapshotFilePath, profileFilePath, journalFilePath });

    const response = await app.inject({ method: 'GET', url: '/api/export/pack' });
    expect(response.statusCode).toBe(200);

    const zip = await JSZip.loadAsync(response.rawPayload);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['meta.json', 'profiles.json', 'universe.json']);

    const metaRaw = await zip.file('meta.json')?.async('string');
    const meta = JSON.parse(metaRaw ?? '{}') as { notes: string[] };
    expect(meta.notes).toContain('runtime.json missing (no persisted runtime snapshot found)');
    expect(meta.notes).toContain('journal.ndjson missing (no journal file found)');

    await rm(tempDir, { recursive: true, force: true });
  });


  it('GET /api/bot/guardrails returns defaults before start', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/guardrails' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      guardrails: {
        maxActiveSymbols: 3,
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
        short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
        reasonCounts: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
        signalsConfirmed: 0,
        signalsBySide: { long: 0, short: 0 },
        signalsByEntryReason: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
        bothHadBothCount: 0,
        bothChosenLongCount: 0,
        bothChosenShortCount: 0,
        bothTieBreakMode: 'shortPriority',
        totalFeesUSDT: 0,
        totalSlippageUSDT: 0,
        avgSpreadBpsEntry: null,
        avgSpreadBpsExit: null,
        expectancyUSDT: null,
        profitFactor: null,
        avgFeePerTradeUSDT: null,
        avgNetPerTradeUSDT: null
      }
    });

    const resetResponse = await app.inject({ method: 'POST', url: '/api/bot/stats/reset', payload: {} });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({ ok: true });
  });


  it('POST /api/reset/all rejects when bot is running', async () => {
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
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1 } });
    await app.inject({
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

    const response = await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: 'BOT_RUNNING' });
  });

  it('POST /api/reset/all clears runtime data while preserving profiles', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'reset-all-route-test-'));
    const universeFilePath = path.join(tempDir, 'universe.json');
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');
    const profileFilePath = path.join(tempDir, 'profiles.json');
    const journalFilePath = path.join(tempDir, 'journal.ndjson');
    const universeExclusionsFilePath = path.join(tempDir, 'universe-exclusions.json');

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
      universeFilePath,
      runtimeSnapshotFilePath,
      profileFilePath,
      journalFilePath,
      universeExclusionsFilePath
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1 } });
    await app.inject({ method: 'POST', url: '/api/universe/exclusions/add', payload: { symbol: 'BTCUSDT' } });

    await app.inject({
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
    await app.inject({ method: 'POST', url: '/api/bot/pause', payload: {} });
    await app.inject({ method: 'POST', url: '/api/bot/stop', payload: {} });

    const resetResponse = await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json()).toEqual({
      ok: true,
      cleared: {
        stats: true,
        journal: true,
        runtime: true,
        exclusions: true,
        universe: true,
        replay: true
      }
    });

    const statsResponse = await app.inject({ method: 'GET', url: '/api/bot/stats' });
    expect(statsResponse.json()).toMatchObject({
      ok: true,
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        pnlUSDT: 0,
        todayPnlUSDT: 0,
        long: { trades: 0 },
        short: { trades: 0 }
      }
    });

    const exclusionsResponse = await app.inject({ method: 'GET', url: '/api/universe/exclusions' });
    expect(exclusionsResponse.statusCode).toBe(200);
    expect(exclusionsResponse.json()).toEqual({ ok: true, excluded: [] });

    const journalTailResponse = await app.inject({ method: 'GET', url: '/api/journal/tail?limit=10' });
    expect(journalTailResponse.statusCode).toBe(200);
    expect(journalTailResponse.json()).toEqual({ ok: true, entries: [expect.objectContaining({ event: 'SYSTEM_RESET_ALL', symbol: 'SYSTEM', side: null })] });

    const resumeResponse = await app.inject({ method: 'POST', url: '/api/bot/resume', payload: {} });
    expect(resumeResponse.statusCode).toBe(400);
    expect(resumeResponse.json()).toEqual({ ok: false, error: 'NO_SNAPSHOT' });

    const replayStateResponse = await app.inject({ method: 'GET', url: '/api/replay/state' });
    expect(replayStateResponse.statusCode).toBe(200);
    expect(replayStateResponse.json()).toMatchObject({
      recording: false,
      replaying: false
    });

    const universeResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(universeResponse.statusCode).toBe(200);
    expect(universeResponse.json()).toMatchObject({ ok: false, ready: false });

    const profilesResponse = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(profilesResponse.statusCode).toBe(200);
    expect(profilesResponse.json()).toEqual({ ok: true, activeProfile: 'default', names: ['default', 'fast_test_1m', 'overnight_1m_safe', 'smoke_min_1m'] });

    await rm(tempDir, { recursive: true, force: true });
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
      ready: true,
      filters: { minTurnover: 20000000, minVolPct: 5 },
      metricDefinition: expect.any(String),
      totals: {
        totalSymbols: 3,
        validSymbols: 3
      },
      passed: 0,
      forcedActive: 0,
      upstreamStatus: 'ok'
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
      filters: { minTurnover: 20000000, minVolPct: 5 },
      metricDefinition: expect.any(String)
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
    expect(getAfterClear.json()).toMatchObject({ ok: false, ready: false });

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
      contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY',
      filters: { minVolPct: 5, minTurnover: 10000000 },
      metricDefinition: expect.any(String),
      filteredOut: {
        expiringOrNonPerp: 0,
        byMetricThreshold: 0,
        dataUnavailable: 0
      },
      symbols: [expect.objectContaining({ symbol: 'BTCUSDT' })]
    });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/universe/download returns UNIVERSE_NOT_FOUND when missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/universe/download' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: 'UNIVERSE_NOT_FOUND' });
  });

  it('persists empty universe as ready and allows get/download', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-empty-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');

    app = buildIsolatedServer({
      universeFilePath,
      marketClient: new FakeMarketClient(
        [
          { symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 },
          { symbol: 'ETHUSDT', qtyStep: 0.01, minOrderQty: 0.01, maxOrderQty: 1000 }
        ],
        new Map([
          [
            'BTCUSDT',
            { symbol: 'BTCUSDT', turnover24h: 1000, highPrice24h: 101, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }
          ]
        ])
      )
    });

    const createResponse = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 50, minTurnover: 10000000 } });
    expect(createResponse.statusCode).toBe(200);

    const getResponse = await app.inject({ method: 'GET', url: '/api/universe' });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      ok: true,
      ready: true,
      symbols: [],
      filteredOut: {
        expiringOrNonPerp: 0,
        byMetricThreshold: 1,
        dataUnavailable: 1
      },
      contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY'
    });

    const downloadResponse = await app.inject({ method: 'GET', url: '/api/universe/download' });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.json()).toMatchObject({
      ready: true,
      symbols: [],
      filteredOut: {
        expiringOrNonPerp: 0,
        byMetricThreshold: 1,
        dataUnavailable: 1
      }
    });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('failed refresh does not overwrite existing persisted universe and keeps download available', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-refresh-fail-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');
    const healthyClient = new FakeMarketClient(
      [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
      new Map([
        ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 105, openInterestValue: 200000 }]
      ])
    );

    app = buildIsolatedServer({ universeFilePath, marketClient: healthyClient });
    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 5 } });

    await app.close();
    app = buildIsolatedServer({
      universeFilePath,
      marketClient: new FailingMarketClient(new BybitApiError('timeout', 'TIMEOUT', true))
    });

    const refreshResponse = await app.inject({ method: 'POST', url: '/api/universe/refresh', payload: {} });
    expect(refreshResponse.statusCode).toBe(502);
    expect(refreshResponse.json()).toMatchObject({
      ok: false,
      diagnostics: {
        upstreamStatus: 'error',
        upstreamError: { code: 'TIMEOUT', retryable: true }
      },
      lastKnownUniverseAvailable: true
    });

    const persisted = JSON.parse(await readFile(universeFilePath, 'utf-8')) as { symbols: Array<{ symbol: string }> };
    expect(persisted.symbols.map((entry) => entry.symbol)).toEqual(['BTCUSDT']);

    const downloadResponse = await app.inject({ method: 'GET', url: '/api/universe/download' });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.json()).toMatchObject({
      ready: true,
      symbols: [expect.objectContaining({ symbol: 'BTCUSDT' })]
    });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('classifies upstream auth errors with stable code and retryable=false', async () => {
    app = buildIsolatedServer({ marketClient: new FailingMarketClient(new BybitApiError('auth failed', 'AUTH_ERROR', false)) });

    const response = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 3 } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      ok: false,
      diagnostics: {
        upstreamStatus: 'error',
        upstreamError: {
          code: 'BYBIT_AUTH_ERROR',
          retryable: false
        }
      },
      lastKnownUniverseAvailable: false
    });
  });

  it('failed create does not overwrite existing persisted universe', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-create-fail-'));
    const universeFilePath = path.join(tempDir, 'data', 'universe.json');

    app = buildIsolatedServer({
      universeFilePath,
      marketClient: new FakeMarketClient(
        [{ symbol: 'ETHUSDT', qtyStep: 0.01, minOrderQty: 0.01, maxOrderQty: 1000 }],
        new Map([
          ['ETHUSDT', { symbol: 'ETHUSDT', turnover24h: 15000000, highPrice24h: 105, lowPrice24h: 100, markPrice: 101, openInterestValue: 100000 }]
        ])
      )
    });
    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 4 } });

    await app.close();
    app = buildIsolatedServer({
      universeFilePath,
      marketClient: new FailingMarketClient(new BybitApiError('network down', 'UNREACHABLE', true))
    });

    const response = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 4 } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      diagnostics: {
        upstreamError: {
          code: 'BYBIT_UNREACHABLE',
          retryable: true
        }
      },
      lastKnownUniverseAvailable: true
    });

    const downloadResponse = await app.inject({ method: 'GET', url: '/api/universe/download' });
    expect(downloadResponse.statusCode).toBe(200);
    expect(downloadResponse.json()).toMatchObject({ symbols: [expect.objectContaining({ symbol: 'ETHUSDT' })] });

    await rm(tempDir, { recursive: true, force: true });
  });




  it('universe route reports tickerMissing diagnostics for mismatch fixture', async () => {
    app = buildIsolatedServer({
      marketClient: new FakeMarketClient(
        [{ symbol: 'ETHUSDT', qtyStep: 0.01, minOrderQty: 0.01, maxOrderQty: 1000 }],
        new Map([
          ['ETH-USDT', { symbol: 'ETH-USDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ])
      )
    });

    const createResponse = await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1, minTurnover: 5000000 } });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      passed: 0,
      diagnostics: {
        totals: { instrumentsTotal: 1, matchedTotal: 0, validTotal: 0 },
        excluded: { tickerMissing: 1 }
      },
      filteredOut: { dataUnavailable: 1 }
    });
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

  it('start -> pause creates snapshot and resume restores running state', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pause-resume-route-test-'));
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');

    app = buildIsolatedServer({
      runtimeSnapshotFilePath,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'paper', direction: 'long', tf: 1, holdSeconds: 1, signalCounterThreshold: 1,
        priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2, tpRoiPct: 1, slRoiPct: 1,
        entryOffsetPct: 0, maxActiveSymbols: 5, dailyLossLimitUSDT: 0, maxConsecutiveLosses: 0, trendTfMinutes: 5, trendLookbackBars: 20,
        trendMinMovePct: 0.2, confirmWindowBars: 2, confirmMinContinuationPct: 0.1, impulseMaxAgeBars: 2, requireOiTwoCandles: false,
        maxSecondsIntoCandle: 45, minSpreadBps: 0, maxSpreadBps: 0, maxTickStalenessMs: 0, minNotionalUSDT: 5
      }
    });

    const pauseResponse = await app.inject({ method: 'POST', url: '/api/bot/pause', payload: {} });
    expect(pauseResponse.statusCode).toBe(200);

    const pausedState = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(pausedState.json()).toMatchObject({ running: true, paused: true, hasSnapshot: true });

    const resumeResponse = await app.inject({ method: 'POST', url: '/api/bot/resume', payload: {} });
    expect(resumeResponse.statusCode).toBe(200);

    const resumedState = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(resumedState.json()).toMatchObject({ running: true, paused: false, hasSnapshot: true });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('lifecycle ops append SYSTEM journal events', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ops-journal-route-test-'));
    const journalFilePath = path.join(tempDir, 'journal.ndjson');
    const runtimeSnapshotFilePath = path.join(tempDir, 'runtime.json');

    await app.close();
    app = buildIsolatedServer({
      journalFilePath,
      runtimeSnapshotFilePath,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'paper', direction: 'long', tf: 1, holdSeconds: 1, signalCounterThreshold: 1,
        priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2, tpRoiPct: 1, slRoiPct: 1,
        entryOffsetPct: 0
      }
    });

    expect((await app.inject({ method: 'POST', url: '/api/bot/pause', payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/bot/resume', payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/bot/kill', payload: {} })).statusCode).toBe(200);

    const beforeResetTail = await app.inject({ method: 'GET', url: '/api/journal/tail?limit=20' });
    const beforeResetEvents = (beforeResetTail.json() as { entries: Array<{ event: string; symbol: string; side: string | null }> }).entries;
    const lifecycleEntries = beforeResetEvents.filter((entry) => ['BOT_PAUSE', 'BOT_RESUME', 'BOT_KILL'].includes(entry.event));
    expect(lifecycleEntries.map((entry) => entry.event)).toEqual(['BOT_PAUSE', 'BOT_RESUME', 'BOT_KILL']);
    for (const entry of lifecycleEntries) {
      expect(entry.symbol).toBe('SYSTEM');
      expect(entry.side).toBeNull();
    }

    await app.inject({ method: 'POST', url: '/api/bot/stop', payload: {} });
    expect((await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} })).statusCode).toBe(200);

    const afterResetTail = await app.inject({ method: 'GET', url: '/api/journal/tail?limit=20' });
    const afterResetEvents = (afterResetTail.json() as { entries: Array<{ event: string; symbol: string; side: string | null }> }).entries;
    expect(afterResetEvents).toHaveLength(1);
    expect(afterResetEvents[0]).toMatchObject({ event: 'SYSTEM_RESET_ALL', symbol: 'SYSTEM', side: null });

    await rm(tempDir, { recursive: true, force: true });
  });

  it('ops routes remain successful when ops journaling append throws', async () => {
    const appendSpy = vi.spyOn(JournalService.prototype, 'append').mockRejectedValue(new Error('append failed'));

    try {
      await app.close();
      app = buildIsolatedServer({
        marketClient: new FakeMarketClient(
          [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
          new Map([
            ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
          ])
        )
      });

      await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
      await app.inject({
        method: 'POST',
        url: '/api/bot/start',
        payload: {
          mode: 'paper', direction: 'long', tf: 1, holdSeconds: 1, signalCounterThreshold: 1,
          priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2, tpRoiPct: 1, slRoiPct: 1,
          entryOffsetPct: 0
        }
      });

      expect((await app.inject({ method: 'POST', url: '/api/bot/pause', payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/bot/resume', payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/bot/kill', payload: {} })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/export/pack' })).statusCode).toBe(200);
      await app.inject({ method: 'POST', url: '/api/bot/stop', payload: {} });
      expect((await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} })).statusCode).toBe(200);
    } finally {
      appendSpy.mockRestore();
    }
  });


  it('paper flow: signal dedupe -> entry pending -> fill -> TP close updates stats and journal', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const tickerStream = new FakeTickerStream();
    app = buildIsolatedServer({
      now: () => now,
      tickerStream,
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', turnover24h: 12000000, highPrice24h: 110, lowPrice24h: 100, markPrice: 100, openInterestValue: 100000 }]
        ])
      )
    });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 1 } });
    await app.inject({
      method: 'POST',
      url: '/api/bot/start',
      payload: {
        mode: 'paper', direction: 'long', tf: 1, holdSeconds: 1, signalCounterThreshold: 2,
        priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2, tpRoiPct: 1, slRoiPct: 1,
        entryOffsetPct: 0.1, maxActiveSymbols: 5, dailyLossLimitUSDT: 0, maxConsecutiveLosses: 0, trendTfMinutes: 5, trendLookbackBars: 20,
        trendMinMovePct: 0, confirmWindowBars: 2, confirmMinContinuationPct: 0, impulseMaxAgeBars: 2, requireOiTwoCandles: false,
        maxSecondsIntoCandle: 45, minSpreadBps: 0, maxSpreadBps: 0, maxTickStalenessMs: 0, minNotionalUSDT: 5
      }
    });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000, ts: now });
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now + 5_000 });
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now + 20_000 });

    let stateResponse = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(stateResponse.json()).toMatchObject({ activeOrders: 0, openPositions: 0 });

    now += 60_000;
    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020, ts: now });
    stateResponse = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(stateResponse.json()).toMatchObject({ activeOrders: 1, openPositions: 0 });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 101.85, openInterestValue: 1020, ts: now + 1_000 });
    stateResponse = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(stateResponse.json()).toMatchObject({ activeOrders: 0, openPositions: 1 });

    tickerStream.emit({ symbol: 'BTCUSDT', markPrice: 102.5, openInterestValue: 1020, ts: now + 2_000 });

    const statsResponse = await app.inject({ method: 'GET', url: '/api/bot/stats' });
    expect(statsResponse.json()).toMatchObject({
      ok: true,
      stats: {
        totalTrades: 1,
        wins: 1,
        losses: 0,
        pnlUSDT: expect.any(Number),
        todayPnlUSDT: expect.any(Number),
        long: { trades: 1, wins: 1, losses: 0 },
        short: { trades: 0, wins: 0, losses: 0 }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    const tailResponse = await app.inject({ method: 'GET', url: '/api/journal/tail?limit=20' });
    const events = (tailResponse.json() as { entries: Array<{ event: string }> }).entries.map((entry) => entry.event);
    expect(events).toEqual(expect.arrayContaining(['SIGNAL', 'ORDER_PLACED', 'ORDER_FILLED', 'POSITION_OPENED', 'POSITION_CLOSED']));
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
    vi.restoreAllMocks();
    await app.close();
    app = buildIsolatedServer();
  });

  it('rejects exclusion updates while bot is running', async () => {
    const marketClient: IBybitMarketClient = {
      async getInstrumentsLinearAll() {
        return [{ symbol: 'BTCUSDT', category: 'linear', contractType: 'Perpetual', status: 'Trading', settleCoin: 'USDT', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 }];
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
      entryOffsetPct: 0, maxActiveSymbols: 5, dailyLossLimitUSDT: 0, maxConsecutiveLosses: 0, trendTfMinutes: 5, trendLookbackBars: 20,
  trendMinMovePct: 0.2, confirmWindowBars: 2,
  confirmMinContinuationPct: 0.1, impulseMaxAgeBars: 2,
  requireOiTwoCandles: false, maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  maxSpreadBps: 35,
  maxTickStalenessMs: 2500,
  minNotionalUSDT: 5
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
          { symbol: 'BTCUSDT', category: 'linear', contractType: 'Perpetual', status: 'Trading', settleCoin: 'USDT', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 },
          { symbol: 'ETHUSDT', category: 'linear', contractType: 'Perpetual', status: 'Trading', settleCoin: 'USDT', quoteCoin: 'USDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 1000 }
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
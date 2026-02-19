import { describe, expect, it } from 'vitest';

import { DoctorService } from '../src/services/doctorService.js';

describe('DoctorService', () => {
  it('returns only thin v2 checks', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: true, paused: false, activeOrders: 0, openPositions: 0, mode: 'paper', tf: 1, direction: 'both' }),
      getMarketStates: () => ({ BTCUSDT: { ts: now - 1000, lastTickTs: now - 1000 } }),
      getTrackedSymbols: () => ['BTCUSDT'],
      getTickerStreamStatus: () => ({ running: true, connected: true, desiredSymbolsCount: 1, subscribedCount: 1, lastMessageAt: now - 200, lastTickerAt: now - 250, reconnectCount: 1, lastError: null }),
      getUniverseState: async () => ({ contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY', diagnostics: { excluded: { expiring: 0 } }, symbols: [{ symbol: 'BTCUSDT' }] })
    });

    const report = await service.buildReport();
    const ids = report.checks.map((check) => check.id);
    expect(ids).toEqual(['ws_freshness', 'market_age_per_symbol', 'lifecycle_invariants', 'universe_contract_filter']);
  });

  it('ws_freshness warns when no desired symbols are subscribed', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: false, paused: false, activeOrders: 0, openPositions: 0, mode: null, tf: null, direction: null }),
      getMarketStates: () => ({}),
      getTrackedSymbols: () => [],
      getTickerStreamStatus: () => ({ running: true, connected: true, desiredSymbolsCount: 0, subscribedCount: 0, lastMessageAt: null, lastTickerAt: null, reconnectCount: 0, lastError: null }),
      getUniverseState: async () => ({ contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY', diagnostics: { excluded: { expiring: 0 } }, symbols: [] })
    });

    const report = await service.buildReport();
    const wsFreshness = report.checks.find((check) => check.id === 'ws_freshness');

    expect(wsFreshness?.status).toBe('WARN');
    expect(wsFreshness?.message).toContain('no symbols subscribed');
  });

  it('ws_freshness ignores stale cached states when desiredSymbolsCount is zero', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: false, paused: false, activeOrders: 0, openPositions: 0, mode: null, tf: null, direction: null }),
      getMarketStates: () => ({ BTCUSDT: { ts: now - 120_000, lastTickTs: now - 120_000 } }),
      getTrackedSymbols: () => [],
      getTickerStreamStatus: () => ({ running: true, connected: true, desiredSymbolsCount: 0, subscribedCount: 0, lastMessageAt: now - 120_000, lastTickerAt: now - 120_000, reconnectCount: 0, lastError: null }),
      getUniverseState: async () => ({ contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY', diagnostics: { excluded: { expiring: 0 } }, symbols: [] })
    });

    const report = await service.buildReport();
    const wsFreshness = report.checks.find((check) => check.id === 'ws_freshness');

    expect(wsFreshness?.status).toBe('WARN');
    expect(wsFreshness?.message).toContain('no symbols subscribed');
  });

  it('ws_freshness uses per-symbol ages even if stream lastMessageAt is old', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: true, paused: false, activeOrders: 0, openPositions: 0, mode: 'paper', tf: 1, direction: 'both' }),
      getMarketStates: () => ({
        BTCUSDT: { ts: now - 500, lastTickTs: now - 500 },
        ETHUSDT: { ts: now - 700, lastTickTs: now - 700 },
        SOLUSDT: { ts: now - 900, lastTickTs: now - 900 }
      }),
      getTrackedSymbols: () => ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      getTickerStreamStatus: () => ({
        running: true,
        connected: true,
        desiredSymbolsCount: 3,
        subscribedCount: 3,
        lastMessageAt: now - 120_000,
        lastTickerAt: now - 120_000,
        reconnectCount: 0,
        lastError: null
      }),
      getUniverseState: async () => ({ contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY', diagnostics: { excluded: { expiring: 0 } }, symbols: [{ symbol: 'BTCUSDT' }] })
    });

    const report = await service.buildReport();
    const wsFreshness = report.checks.find((check) => check.id === 'ws_freshness');

    expect(wsFreshness?.status).toBe('PASS');
  });

  it('ws_freshness returns FAIL when present symbol data is stale for desired symbols', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: true, paused: false, activeOrders: 0, openPositions: 0, mode: 'paper', tf: 1, direction: 'both' }),
      getMarketStates: () => ({ BTCUSDT: { ts: now - 20_000, lastTickTs: now - 20_000 } }),
      getTrackedSymbols: () => ['BTCUSDT'],
      getTickerStreamStatus: () => ({ running: true, connected: true, desiredSymbolsCount: 1, subscribedCount: 1, lastMessageAt: now - 100, lastTickerAt: now - 100, reconnectCount: 0, lastError: null }),
      getUniverseState: async () => ({ contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY', diagnostics: { excluded: { expiring: 0 } }, symbols: [{ symbol: 'BTCUSDT' }] })
    });

    const report = await service.buildReport();
    const wsFreshness = report.checks.find((check) => check.id === 'ws_freshness');

    expect(wsFreshness?.status).toBe('FAIL');
    expect(wsFreshness?.details).toMatchObject({ thresholdMs: 15000, worstAgeMs: 20000 });
  });
});

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
});

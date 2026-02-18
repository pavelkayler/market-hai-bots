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
});

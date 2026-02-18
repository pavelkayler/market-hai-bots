import { describe, expect, it } from 'vitest';

import { DoctorService } from '../src/services/doctorService.js';

describe('DoctorService', () => {
  it('returns PASS checks for healthy state', async () => {
    const now = 1_700_000_000_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: true, paused: false, activeOrders: 0, openPositions: 0, mode: 'paper', tf: 1, direction: 'both' }),
      getMarketStates: () => ({
        BTCUSDT: { ts: now - 1000, lastTickTs: now - 1000 },
        ETHUSDT: { ts: now - 1200, lastTickTs: now - 1200 }
      }),
      getTrackedSymbols: () => ['BTCUSDT', 'ETHUSDT'],
      getUniverseState: async () => ({
        contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY',
        diagnostics: { excluded: { nonUSDT: 0, expiring: 0, nonPerp: 0 } },
        symbols: [{ symbol: 'BTCUSDT' }, { symbol: 'ETHUSDT' }]
      }),
      getCurrentRunDir: () => process.cwd(),
      getRunRecorderLastWriteError: () => null,
      getDataDir: () => process.cwd(),
      getVersion: async () => ({ commit: 'abc123', node: process.version })
    });

    const report = await service.buildReport();

    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
    expect(report.checks.find((check) => check.id === 'ws_freshness')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.id === 'run_recording_status')?.status).toBe('PASS');
  });

  it('maps stale market feed to WARN/FAIL and run recorder errors to FAIL', async () => {
    const now = 1_700_000_100_000;
    const service = new DoctorService({
      now: () => now,
      getBotState: () => ({ running: true, paused: false, activeOrders: 0, openPositions: 0, mode: 'demo', tf: 1, direction: 'long' }),
      getMarketStates: () => ({
        BTCUSDT: { ts: now - 35_000, lastTickTs: now - 35_000 }
      }),
      getTrackedSymbols: () => ['BTCUSDT', 'BTCUSDT-26JUN26'],
      getUniverseState: async () => ({
        contractFilter: 'USDT_LINEAR_PERPETUAL_ONLY',
        diagnostics: { excluded: { expiring: 1 } },
        symbols: [{ symbol: 'BTCUSDT' }]
      }),
      getCurrentRunDir: () => null,
      getRunRecorderLastWriteError: () => 'EACCES',
      getDataDir: () => process.cwd()
    });

    const report = await service.buildReport();

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'ws_freshness')?.status).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'run_recording_status')?.status).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'universe_contract_filter')?.status).toBe('FAIL');
  });
});

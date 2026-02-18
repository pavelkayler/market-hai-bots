import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunHistoryService } from '../src/services/runHistoryService.js';

describe('RunHistoryService', () => {
  it('summarizes runs with best-effort stats and traded symbols', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'run-history-'));

    try {
      const runA = path.join(baseDir, '2025-01-02T00-00-00.000Z');
      await mkdir(runA, { recursive: true });
      await writeFile(path.join(runA, 'meta.json'), JSON.stringify({ startTime: 1, configSnapshot: { mode: 'paper', tf: 1, direction: 'both' }, universeSummary: { effective: 2 } }), 'utf-8');
      await writeFile(path.join(runA, 'stats.json'), JSON.stringify({ totalTrades: 5, winratePct: 40, pnlUSDT: -5 }), 'utf-8');
      await writeFile(path.join(runA, 'events.ndjson'), `${JSON.stringify({ type: 'position:update', payload: { symbol: 'BTCUSDT', status: 'OPEN' } })}\n`, 'utf-8');

      const runB = path.join(baseDir, '2025-01-01T00-00-00.000Z');
      await mkdir(runB, { recursive: true });
      await writeFile(path.join(runB, 'meta.json'), JSON.stringify({ startTime: 2, configSnapshot: { mode: 'demo', tf: 5, direction: 'long' } }), 'utf-8');
      await writeFile(path.join(runB, 'events.ndjson'), `${JSON.stringify({ type: 'order:update', payload: { symbol: 'ETHUSDT', status: 'FILLED' } })}\n`, 'utf-8');

      const service = new RunHistoryService(baseDir);
      const summary = await service.summarizeRecent(20);
      expect(summary).toHaveLength(2);
      expect(summary[0]).toMatchObject({ id: '2025-01-02T00-00-00.000Z', hasStats: true, tradedSymbols: ['BTCUSDT'] });
      expect(summary[1]).toMatchObject({ id: '2025-01-01T00-00-00.000Z', hasStats: false, tradedSymbols: ['ETHUSDT'] });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

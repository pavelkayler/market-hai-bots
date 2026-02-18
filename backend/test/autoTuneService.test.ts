import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AutoTuneService } from '../src/services/autoTuneService.js';
import { normalizeBotConfig } from '../src/bot/botEngine.js';

describe('AutoTuneService', () => {
  it('persists state across restarts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autotune-state-'));
    const filePath = path.join(dir, 'state.json');

    try {
      const serviceA = new AutoTuneService(filePath);
      await serviceA.init();
      await serviceA.setEnabledScope(true, 'GLOBAL');
      await serviceA.noteApplied({ parameter: 'priceUpThrPct', before: 0.5, after: 0.45, reason: 'test', bounds: { min: 0.05, max: 5 } });

      const serviceB = new AutoTuneService(filePath);
      await serviceB.init();
      const state = serviceB.getState();
      expect(state.enabled).toBe(true);
      expect(state.scope).toBe('GLOBAL');
      expect(state.lastApplied?.parameter).toBe('priceUpThrPct');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps legacy signalCounterThreshold to min/max range semantics', () => {
    const normalized = normalizeBotConfig({
      mode: 'paper',
      direction: 'both',
      tf: 1,
      holdSeconds: 3,
      signalCounterThreshold: 4,
      priceUpThrPct: 0.5,
      oiUpThrPct: 50,
      oiCandleThrPct: 0,
      marginUSDT: 100,
      leverage: 10,
      tpRoiPct: 1,
      slRoiPct: 1
    });

    expect(normalized).toBeTruthy();
    expect(normalized?.signalCounterMin).toBe(4);
    expect(normalized?.signalCounterMax).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('retains lastApplied and appends bounded history entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'autotune-state-'));
    const filePath = path.join(dir, 'state.json');

    try {
      const service = new AutoTuneService(filePath);
      await service.init();
      await service.noteApplied({ parameter: 'priceUpThrPct', before: 0.5, after: 0.45, reason: 'first', bounds: { min: 0.1, max: 5 } });
      await service.noteApplied({ parameter: 'minNotionalUSDT', before: 5, after: 6, reason: 'second', bounds: { min: 1, max: 100 } });

      const state = service.getState();
      expect(state.lastApplied?.parameter).toBe('minNotionalUSDT');
      expect(state.history).toHaveLength(2);
      expect(state.history[0].parameter).toBe('priceUpThrPct');
      expect(state.history[1].parameter).toBe('minNotionalUSDT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

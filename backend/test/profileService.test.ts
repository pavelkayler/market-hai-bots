import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot/botEngine.js';
import { ProfileService } from '../src/services/profileService.js';

const customConfig: BotConfig = {
  mode: 'paper', direction: 'short', bothTieBreak: 'shortPriority', tf: 1, strategyMode: 'IMPULSE', holdSeconds: 1,
  signalCounterThreshold: 2, signalCounterMin: 2, signalCounterMax: Number.MAX_SAFE_INTEGER,
  priceUpThrPct: 0.25, oiUpThrPct: 25, minFundingAbs: 0, oiCandleThrPct: 0, marginUSDT: 100, leverage: 20,
  tpRoiPct: 1.5, slRoiPct: 0.8, entryOffsetPct: 0.01, maxActiveSymbols: 5, dailyLossLimitUSDT: 0, maxConsecutiveLosses: 0,
  trendTfMinutes: 5, trendLookbackBars: 20, trendMinMovePct: 0.2, confirmWindowBars: 2, confirmMinContinuationPct: 0.1,
  impulseMaxAgeBars: 2, requireOiTwoCandles: false, maxSecondsIntoCandle: 45, minSpreadBps: 0, maxSpreadBps: 35,
  maxTickStalenessMs: 2500, minNotionalUSDT: 5, autoTuneEnabled: true, autoTuneScope: 'GLOBAL', autoTunePlannerMode: 'DETERMINISTIC', autoTuneWindowHours: 24, autoTuneTargetTradesInWindow: 6, autoTuneMinTradesBeforeTighten: 4
};

const shippedPresets = [
  'aggressive_1m', 'aggressive_3m', 'aggressive_5m', 'balanced_1m', 'balanced_3m', 'balanced_5m',
  'conservative_1m', 'conservative_3m', 'conservative_5m', 'skip_trades_max_filter'
];

describe('ProfileService', () => {
  it('loads empty storage with named default profile and seeded presets', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      const list = await service.list();
      expect(list.names).toEqual([...shippedPresets].sort((a, b) => a.localeCompare(b)));
      expect(list.activeProfile).toBe('balanced_1m');
      const legacyDefaultProfile = await service.get('default');
      expect(legacyDefaultProfile?.dailyLossLimitUSDT).toBe(0);
      expect(legacyDefaultProfile?.maxConsecutiveLosses).toBe(0);
      expect(await service.get('fast_test_1m')).toBeNull();
      expect(await service.get('skip_most_trades')).toBeNull();
      expect((await service.get('aggressive_1m'))?.autoTunePlannerMode).toBe('RANDOM_EXPLORE');
      expect((await service.get('balanced_3m'))?.autoTunePlannerMode).toBe('DETERMINISTIC');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('persists active profile across service reloads', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-persist-test-'));
    const filePath = path.join(tempDir, 'profiles.json');

    try {
      const serviceA = new ProfileService(filePath);
      await serviceA.set('custom_live', customConfig);
      await serviceA.setActive('custom_live');

      const serviceB = new ProfileService(filePath);
      const list = await serviceB.list();
      expect(list.activeProfile).toBe('custom_live');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy default active profile and hides it from list', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-legacy-test-'));
    const filePath = path.join(tempDir, 'profiles.json');

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          activeProfile: 'default',
          profiles: {
            default: customConfig
          }
        }),
        'utf-8'
      );

      const service = new ProfileService(filePath);
      const list = await service.list();
      expect(list.activeProfile).toBe('balanced_1m');
      expect(list.names).not.toContain('default');
      expect(list.names).toContain('balanced_1m');

      const persisted = JSON.parse(await readFile(filePath, 'utf-8')) as { activeProfile: string; profiles: Record<string, unknown> };
      expect(persisted.activeProfile).toBe('balanced_1m');
      expect(Object.keys(persisted.profiles)).toContain('default');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('list output always points active profile to a visible existing profile', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-list-active-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      const list = await service.list();
      expect(list.names).toContain(list.activeProfile);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

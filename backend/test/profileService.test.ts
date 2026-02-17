import { mkdtemp, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot/botEngine.js';
import { ProfileService } from '../src/services/profileService.js';

const aggressiveConfig: BotConfig = {
  mode: 'paper',
  direction: 'short',
  bothTieBreak: 'shortPriority',
  tf: 1,
  holdSeconds: 1,
  signalCounterThreshold: 2,
  priceUpThrPct: 0.25,
  oiUpThrPct: 25,
  oiCandleThrPct: 0,
  marginUSDT: 100,
  leverage: 20,
  tpRoiPct: 1.5,
  slRoiPct: 0.8,
  entryOffsetPct: 0,
  maxActiveSymbols: 5,
  dailyLossLimitUSDT: 0,
  maxConsecutiveLosses: 0,
  trendTfMinutes: 5,
  trendLookbackBars: 20,
  trendMinMovePct: 0.2,
  confirmWindowBars: 2,
  confirmMinContinuationPct: 0.1,
  impulseMaxAgeBars: 2,
  requireOiTwoCandles: false,
  maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  maxSpreadBps: 35,
  maxTickStalenessMs: 2500,
  minNotionalUSDT: 5
};

describe('ProfileService', () => {
  it('set/get/list/delete rules and default protection', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      const initial = await service.list();
      expect(initial.activeProfile).toBe('default');
      expect(initial.names).toContain('default');

      await service.set('aggressive', aggressiveConfig);
      const saved = await service.get('aggressive');
      expect(saved).toEqual(aggressiveConfig);

      await service.setActive('aggressive');
      const afterActivate = await service.list();
      expect(afterActivate.activeProfile).toBe('aggressive');

      await service.delete('aggressive');
      expect(await service.get('aggressive')).toBeNull();

      await expect(service.delete('default')).rejects.toThrow('DEFAULT_PROFILE_LOCKED');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('import merges and overwrites profiles with same name', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-merge-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      await service.set('aggressive', aggressiveConfig);

      await service.import({
        activeProfile: 'balanced',
        profiles: {
          aggressive: { ...aggressiveConfig, leverage: 5 },
          balanced: {
            ...aggressiveConfig,
            direction: 'both',
            tf: 3,
            holdSeconds: 2,
  signalCounterThreshold: 2,
            priceUpThrPct: 0.6
          }
        }
      });

      const list = await service.list();
      expect(list.activeProfile).toBe('balanced');
      expect(list.names).toEqual(['aggressive', 'balanced', 'default', 'fast_test_1m', 'overnight_1m_safe']);
      expect(await service.get('aggressive')).toMatchObject({ ...aggressiveConfig, leverage: 5 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes missing entryOffsetPct in imported legacy profile to default 0.01', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-legacy-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      await service.import({
        activeProfile: 'legacy',
        profiles: {
          legacy: {
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
            maxActiveSymbols: 5,
            dailyLossLimitUSDT: 0,
            maxConsecutiveLosses: 0, trendTfMinutes: 5, trendLookbackBars: 20,
  trendMinMovePct: 0.2, confirmWindowBars: 2,
  confirmMinContinuationPct: 0.1, impulseMaxAgeBars: 2,
  requireOiTwoCandles: false, maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  maxSpreadBps: 35,
  maxTickStalenessMs: 2500,
  minNotionalUSDT: 5
          }
        }
      });

      const profile = await service.get('legacy');
      expect(profile?.entryOffsetPct).toBe(0.01);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('seeds starter profiles only when missing names', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-seed-test-'));
    const filePath = path.join(tempDir, 'profiles.json');
    await writeFile(
      filePath,
      JSON.stringify({
        activeProfile: 'default',
        profiles: {
          default: aggressiveConfig,
          fast_test_1m: { ...aggressiveConfig, leverage: 7 }
        }
      }),
      'utf-8'
    );
    const service = new ProfileService(filePath);

    try {
      const fast = await service.get('fast_test_1m');
      const overnight = await service.get('overnight_1m_safe');
      expect(fast?.leverage).toBe(7);
      expect(fast?.signalCounterThreshold).toBe(2);
      expect(overnight?.signalCounterThreshold).toBe(3);
      expect(overnight?.priceUpThrPct).toBe(0.6);
      expect(overnight?.oiUpThrPct).toBe(0.8);
      expect(overnight?.entryOffsetPct).toBe(0.01);
      expect(overnight?.maxTickStalenessMs).toBe(1200);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('ships paper-testing starter presets with guardrails enabled by default', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'profile-service-starter-guardrails-test-'));
    const service = new ProfileService(path.join(tempDir, 'profiles.json'));

    try {
      const fast = await service.get('fast_test_1m');
      const overnight = await service.get('overnight_1m_safe');

      expect(fast).toBeTruthy();
      expect(overnight).toBeTruthy();

      for (const preset of [fast, overnight]) {
        expect(preset?.maxConsecutiveLosses ?? 0).toBeGreaterThan(0);
        expect(preset?.dailyLossLimitUSDT ?? 0).toBeGreaterThan(0);
        expect(preset?.signalCounterThreshold ?? 0).toBeGreaterThanOrEqual(2);
        expect(preset?.oiCandleThrPct ?? -1).toBeGreaterThanOrEqual(0);
        expect(preset?.entryOffsetPct).toBe(0.01);
        expect(preset?.maxSpreadBps ?? 0).toBeGreaterThan(0);
        expect(preset?.maxTickStalenessMs ?? 0).toBeGreaterThan(0);
      }

      expect((overnight?.maxActiveSymbols ?? 99)).toBeLessThanOrEqual(2);
      expect((overnight?.trendTfMinutes ?? 0)).toBeGreaterThanOrEqual(5);
      expect((overnight?.confirmWindowBars ?? 0)).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

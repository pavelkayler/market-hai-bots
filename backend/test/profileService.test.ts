import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BotConfig } from '../src/bot/botEngine.js';
import { ProfileService } from '../src/services/profileService.js';

const aggressiveConfig: BotConfig = {
  mode: 'paper',
  direction: 'short',
  tf: 1,
  holdSeconds: 1,
  priceUpThrPct: 0.25,
  oiUpThrPct: 25,
  marginUSDT: 100,
  leverage: 20,
  tpRoiPct: 1.5,
  slRoiPct: 0.8
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
            priceUpThrPct: 0.6
          }
        }
      });

      const list = await service.list();
      expect(list.activeProfile).toBe('balanced');
      expect(list.names).toEqual(['aggressive', 'balanced', 'default']);
      expect(await service.get('aggressive')).toEqual({ ...aggressiveConfig, leverage: 5 });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

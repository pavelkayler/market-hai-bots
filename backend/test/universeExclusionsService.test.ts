import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { UniverseExclusionsService } from '../src/services/universeExclusionsService.js';

describe('UniverseExclusionsService', () => {
  it('persists current file and timestamped snapshot on add/remove', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exclusions-'));
    const filePath = path.join(dir, 'universe_exclusions.json');
    const service = new UniverseExclusionsService(filePath);

    await service.add('btcusdt');
    await service.remove('BTCUSDT');

    const files = await readdir(dir);
    expect(files).toContain('universe_exclusions.json');
    expect(files.some((name) => /^universe_exclusions_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/.test(name))).toBe(true);

    const current = JSON.parse(await readFile(filePath, 'utf-8')) as { excluded: string[] };
    expect(current.excluded).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});

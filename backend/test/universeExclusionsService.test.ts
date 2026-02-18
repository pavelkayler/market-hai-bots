import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { UniverseExclusionsService } from '../src/services/universeExclusionsService.js';

describe('UniverseExclusionsService', () => {
  it('persists current file and timestamped snapshot on add/remove', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'exclusions-'));
    const filePath = path.join(dir, 'universe-exclusions.json');
    const service = new UniverseExclusionsService(filePath);

    await service.add('btcusdt');
    await service.remove('BTCUSDT');

    const files = await readdir(dir);
    expect(files).toContain('universe-exclusions.json');
    expect(files.some((name) => /^universe-exclusions-\d{8}-\d{6}\.json$/.test(name))).toBe(true);

    const current = JSON.parse(await readFile(filePath, 'utf-8')) as { symbols: string[] };
    expect(current.symbols).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});

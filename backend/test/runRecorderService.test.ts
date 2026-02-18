import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RunRecorderService } from '../src/services/runRecorderService.js';

describe('RunRecorderService.getRunPayload', () => {
  it('includes stats.json when present and valid', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'run-recorder-'));
    const runId = '2025-01-01T00-00-00.000Z';
    const runDir = path.join(baseDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'meta.json'), '{"ok":true}', 'utf-8');
    await writeFile(path.join(runDir, 'events.ndjson'), '', 'utf-8');
    await writeFile(path.join(runDir, 'stats.json'), '{"totalTrades":1}', 'utf-8');

    try {
      const service = new RunRecorderService(baseDir);
      const payload = await service.getRunPayload(runId);
      expect(payload).toBeTruthy();
      expect(payload?.['stats.json']).toContain('totalTrades');
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('omits stats.json when missing or corrupted', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'run-recorder-'));
    const runId = '2025-01-01T00-00-00.000Z';
    const runDir = path.join(baseDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'meta.json'), '{"ok":true}', 'utf-8');
    await writeFile(path.join(runDir, 'events.ndjson'), '', 'utf-8');

    try {
      const service = new RunRecorderService(baseDir);
      const missingStats = await service.getRunPayload(runId);
      expect(missingStats?.['stats.json']).toBeUndefined();

      await writeFile(path.join(runDir, 'stats.json'), '{invalid json', 'utf-8');
      const badStats = await service.getRunPayload(runId);
      expect(badStats?.['stats.json']).toBeUndefined();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});

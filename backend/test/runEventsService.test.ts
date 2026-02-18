import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RunEventsService } from '../src/services/runEventsService.js';

describe('RunEventsService', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('tails events and applies SYSTEM/event filtering most-recent-first', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'run-events-'));
    tempDirs.push(baseDir);
    const runId = '2026-01-01T00-00-00.000Z';
    const runDir = path.join(baseDir, runId);
    await mkdir(runDir, { recursive: true });

    const lines = [
      JSON.stringify({ ts: 1, type: 'SYSTEM', event: 'BOT_START' }),
      JSON.stringify({ ts: 2, type: 'position:update', payload: { symbol: 'BTCUSDT' } }),
      JSON.stringify({ ts: 3, type: 'SYSTEM', event: 'AUTO_TUNE_APPLIED', payload: { type: 'AUTO_TUNE_APPLIED' } }),
      JSON.stringify({ ts: 4, type: 'SYSTEM', event: 'BOT_STOP' })
    ];
    await writeFile(path.join(runDir, 'events.ndjson'), `${lines.join('\n')}\n`, 'utf-8');

    const service = new RunEventsService(baseDir);
    const result = await service.tailEvents(runId, { limit: 2, types: ['SYSTEM'] });

    expect(result.events).toEqual([
      expect.objectContaining({ ts: 4, event: 'BOT_STOP' }),
      expect.objectContaining({ ts: 3, event: 'AUTO_TUNE_APPLIED' })
    ]);
  });

  it('returns warnings for malformed lines and missing file without throwing', async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), 'run-events-'));
    tempDirs.push(baseDir);
    const runId = '2026-01-02T00-00-00.000Z';
    const runDir = path.join(baseDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'events.ndjson'), '{"ts":1,"type":"SYSTEM","event":"BOT_START"}\nnot-json\n', 'utf-8');

    const service = new RunEventsService(baseDir);
    const malformedResult = await service.tailEvents(runId, { limit: 20, types: ['SYSTEM'] });
    expect(malformedResult.events).toHaveLength(1);
    expect(malformedResult.warnings).toContain('events.ndjson line parse failed');

    const missingResult = await service.tailEvents('missing-run', { limit: 20, types: ['SYSTEM'] });
    expect(missingResult.events).toEqual([]);
    expect(missingResult.warnings).toContain('events.ndjson missing');
  });
});

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { JournalService, type JournalEntry } from '../src/services/journalService.js';

describe('JournalService', () => {
  it('appends entries and tails last N in order', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
    const service = new JournalService(path.join(tempDir, 'journal.ndjson'));

    const entries: JournalEntry[] = [
      { ts: 1, mode: 'paper', symbol: 'BTCUSDT', event: 'SIGNAL', side: 'LONG', data: { markPrice: 100 } },
      { ts: 2, mode: 'paper', symbol: 'BTCUSDT', event: 'ORDER_PLACED', side: 'LONG', data: { qty: 1 } },
      { ts: 3, mode: 'paper', symbol: 'BTCUSDT', event: 'ORDER_FILLED', side: 'LONG', data: { qty: 1 } }
    ];

    for (const entry of entries) {
      await service.append(entry);
    }

    expect(await service.tail(2)).toEqual(entries.slice(1));
  });

  it('clear removes journal file', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
    const filePath = path.join(tempDir, 'journal.ndjson');
    const service = new JournalService(filePath);

    await service.append({ ts: 1, mode: 'demo', symbol: 'ETHUSDT', event: 'SIGNAL', side: 'SHORT', data: {} });
    await service.clear();

    expect(await service.readRaw()).toBe('');
  });

  it('raw file can be transformed to CSV rows with header shape', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'journal-test-'));
    const filePath = path.join(tempDir, 'journal.ndjson');
    const service = new JournalService(filePath);

    await service.append({
      ts: 10,
      mode: 'paper',
      symbol: 'SOLUSDT',
      event: 'POSITION_CLOSED',
      side: 'LONG',
      data: { qty: 2, entryPrice: 123.4, exitPrice: 124.5, pnlUSDT: 2.2 }
    });

    const firstLine = (await readFile(filePath, 'utf-8')).split('\n').filter(Boolean)[0];
    const parsed = JSON.parse(firstLine) as JournalEntry;
    const header = 'ts,mode,symbol,event,side,qty,price,exitPrice,pnlUSDT,detailsJson';
    const row = `${parsed.ts},${parsed.mode},${parsed.symbol},${parsed.event},${parsed.side ?? ''},${parsed.data.qty ?? ''},${parsed.data.entryPrice ?? ''},${parsed.data.exitPrice ?? ''},${parsed.data.pnlUSDT ?? ''},"${JSON.stringify(parsed.data).replaceAll('"', '""')}"`;

    expect([header, row][0]).toBe('ts,mode,symbol,event,side,qty,price,exitPrice,pnlUSDT,detailsJson');
    expect(row).toContain('SOLUSDT,POSITION_CLOSED,LONG,2,123.4,124.5,2.2');
  });
});

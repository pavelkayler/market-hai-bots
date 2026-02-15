import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplayService, type ReplayTick } from '../src/replay/replayService.js';

describe('ReplayService', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes NDJSON records from market ticks with expected fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-record-'));
    tempDirs.push(dir);

    let tickHandler: ((symbol: string, state: { markPrice: number; openInterestValue: number; ts: number }) => void) | null = null;

    const service = new ReplayService({
      getUniverse: async () => ({
        createdAt: 1,
        ready: true,
        filters: { minTurnover: 10000000, minVolPct: 10 },
        symbols: [{ symbol: 'BTCUSDT', turnover24h: 50000000, highPrice24h: 1, lowPrice24h: 1, vol24hPct: 10, forcedActive: false }]
      }),
      getCurrentBotMode: () => 'paper',
      isBotRunning: () => false,
      disableLiveMarket: async () => {},
      enableLiveMarket: async () => {},
      feedTick: () => {},
      subscribeMarketTicks: (handler) => {
        tickHandler = handler;
        return () => {
          tickHandler = null;
        };
      },
      log: () => {},
      replayDir: dir,
      now: () => 1000
    });

    await service.startRecording('session.ndjson', 20);
    tickHandler?.('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: 500 });
    tickHandler?.('BTCUSDT', { markPrice: 101, openInterestValue: 1010, ts: 750 });
    tickHandler?.('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: 1100 });
    const stop = await service.stopRecording();

    expect(stop.recordsWritten).toBe(2);

    const content = await readFile(path.join(dir, 'session.ndjson'), 'utf-8');
    const lines = content.trim().split('\n').map((line) => JSON.parse(line) as ReplayTick);

    expect(lines).toEqual([
      { ts: 500, symbol: 'BTCUSDT', markPrice: 100, openInterestValue: 1000 },
      { ts: 1100, symbol: 'BTCUSDT', markPrice: 102, openInterestValue: 1020 }
    ]);
  });

  it('replays NDJSON ticks in file order in fast mode without sleeps', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'replay-run-'));
    tempDirs.push(dir);

    await writeFile(
      path.join(dir, 'session.ndjson'),
      `${JSON.stringify({ ts: 1000, symbol: 'ETHUSDT', markPrice: 10, openInterestValue: 100 })}\n${JSON.stringify({ ts: 900, symbol: 'BTCUSDT', markPrice: 20, openInterestValue: 200 })}\n`,
      'utf-8'
    );

    const fedTicks: Array<{ symbol: string; state: { markPrice: number; openInterestValue: number; ts: number } }> = [];
    const sleepSpy = vi.fn(async () => {});

    const service = new ReplayService({
      getUniverse: async () => null,
      getCurrentBotMode: () => 'paper',
      isBotRunning: () => false,
      disableLiveMarket: async () => {},
      enableLiveMarket: async () => {},
      feedTick: (symbol, state) => {
        fedTicks.push({ symbol, state });
      },
      subscribeMarketTicks: () => () => {},
      log: () => {},
      replayDir: dir,
      sleep: sleepSpy,
      now: () => 1000
    });

    await service.startReplay('session.ndjson', 'fast');

    await vi.waitFor(() => {
      expect(service.getState().replaying).toBe(false);
    });

    expect(sleepSpy).not.toHaveBeenCalled();
    expect(fedTicks).toEqual([
      { symbol: 'ETHUSDT', state: { markPrice: 10, openInterestValue: 100, ts: 1000 } },
      { symbol: 'BTCUSDT', state: { markPrice: 20, openInterestValue: 200, ts: 900 } }
    ]);
  });
});

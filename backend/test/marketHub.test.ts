import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketHub } from '../src/market/marketHub.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';
import { SymbolUpdateBroadcaster } from '../src/ws/symbolUpdateBroadcaster.js';

class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async setSymbols(): Promise<void> {}

  onTicker(handler: (update: TickerUpdate) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(update: TickerUpdate): void {
    this.handler?.(update);
  }
}


afterEach(() => {
  vi.useRealTimers();
});

describe('MarketHub', () => {
  it('updates in-memory market state when ticker stream emits updates', async () => {
    const fakeStream = new FakeTickerStream();
    const hub = new MarketHub({ tickerStream: fakeStream });

    await hub.start();

    fakeStream.emit({
      symbol: 'BTCUSDT',
      markPrice: 100,
      openInterestValue: 250000,
      ts: 123456
    });

    expect(hub.getState('BTCUSDT')).toEqual({
      markPrice: 100,
      openInterestValue: 250000,
      openInterest: null,
      ts: 123456,
      lastPrice: null,
      bid: null,
      ask: null,
      spreadBps: null,
      lastTickTs: 123456
    });

    expect(hub.getAllStates()).toEqual({
      BTCUSDT: {
        markPrice: 100,
        openInterestValue: 250000,
        openInterest: null,
        ts: 123456,
        lastPrice: null,
        bid: null,
        ask: null,
        spreadBps: null,
        lastTickTs: 123456
      }
    });
  });
});

describe('SymbolUpdateBroadcaster', () => {
  it('sends symbol:update payload to connected clients', () => {
    const send = vi.fn();
    const clients = new Set([{ send }]);
    const broadcaster = new SymbolUpdateBroadcaster(clients, 500);

    broadcaster.broadcast(
      'BTCUSDT',
      {
        markPrice: 101,
        openInterestValue: 310000,
        ts: 999
      },
      'HOLDING_LONG',
      { basePrice: 100, baseOiValue: 300000, baseTs: 500 },
      null,
      null
    );

    expect(send).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse(send.mock.calls[0][0] as string) as {
      type: string;
      payload: {
        symbol: string;
        state: string;
        markPrice: number;
        openInterestValue: number;
        oiCandleValue: number | null;
        oiPrevCandleValue: number | null;
        oiCandleDeltaValue: number | null;
        oiCandleDeltaPct: number | null;
        baseline: { basePrice: number; baseOiValue: number; baseTs: number };
        pendingOrder: null;
        position: null;
      };
    };

    expect(sentPayload.type).toBe('symbol:update');
    expect(sentPayload.payload).toEqual({
      symbol: 'BTCUSDT',
      state: 'HOLDING_LONG',
      markPrice: 101,
      openInterestValue: 310000,
      oiCandleValue: null,
      oiPrevCandleValue: null,
      oiCandleDeltaValue: null,
      oiCandleDeltaPct: null,
      baseline: { basePrice: 100, baseOiValue: 300000, baseTs: 500 },
      pendingOrder: null,
      position: null
    });
  });

  it('batches symbol updates into one symbols:update event in batch mode', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const clients = new Set([{ send }]);
    const broadcaster = new SymbolUpdateBroadcaster(clients, 0, { mode: 'batch', batchWindowMs: 250, batchMaxSymbols: 50 });

    broadcaster.broadcast('BTCUSDT', { markPrice: 100, openInterestValue: 200000, ts: 1 }, 'IDLE', null, null, null);
    broadcaster.broadcast('ETHUSDT', { markPrice: 200, openInterestValue: 300000, ts: 1 }, 'IDLE', null, null, null);
    broadcaster.broadcast('SOLUSDT', { markPrice: 20, openInterestValue: 400000, ts: 1 }, 'IDLE', null, null, null);

    expect(send).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(250);

    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][0] as string) as { type: string; payload: { updates: Array<{ symbol: string }> } };
    expect(payload.type).toBe('symbols:update');
    expect(payload.payload.updates).toHaveLength(3);
  });

  it('enforces bounded batch buffer size', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const clients = new Set([{ send }]);
    const broadcaster = new SymbolUpdateBroadcaster(clients, 0, {
      mode: 'batch',
      batchWindowMs: 1_000,
      batchMaxSymbols: 10,
      maxBufferedSymbols: 3
    });

    for (const symbol of ['A', 'B', 'C', 'D', 'E']) {
      broadcaster.broadcast(symbol, { markPrice: 1, openInterestValue: 1, ts: 1 }, 'IDLE', null, null, null);
    }

    broadcaster.reset();

    expect(send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(send.mock.calls[0][0] as string) as { payload: { updates: Array<{ symbol: string }> } };
    expect(payload.payload.updates.length).toBeLessThanOrEqual(3);
  });
});

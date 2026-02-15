import { describe, expect, it, vi } from 'vitest';

import { MarketHub } from '../src/market/marketHub.js';
import type { TickerStream, TickerUpdate } from '../src/market/tickerStream.js';
import { SymbolUpdateBroadcaster } from '../src/ws/symbolUpdateBroadcaster.js';

class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async setSymbols(_symbols: string[]): Promise<void> {}

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
      ts: 123456
    });

    expect(hub.getAllStates()).toEqual({
      BTCUSDT: {
        markPrice: 100,
        openInterestValue: 250000,
        ts: 123456
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
      { basePrice: 100, baseOiValue: 300000, baseTs: 500 }
      ,
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
      baseline: { basePrice: 100, baseOiValue: 300000, baseTs: 500 },
      pendingOrder: null,
      position: null
    });
  });
});

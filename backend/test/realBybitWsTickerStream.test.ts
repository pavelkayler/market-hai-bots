import { describe, expect, it } from 'vitest';

import { chunkSymbols, shouldForceReconnect } from '../src/market/realBybitWsTickerStream.js';

describe('realBybitWsTickerStream helpers', () => {
  it('chunks symbols into bounded batches', () => {
    const symbols = Array.from({ length: 33 }, (_, index) => `SYM${index}`);
    const chunks = chunkSymbols(symbols, 10);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[3]).toHaveLength(3);
  });

  it('watchdog reconnect decision triggers on stale message/ticker', () => {
    expect(shouldForceReconnect({ nowMs: 40_000, lastMessageAt: 5_000, lastTickerAt: 35_000, staleMs: 30_000, staleTickerMs: 30_000 })).toBe(true);
    expect(shouldForceReconnect({ nowMs: 40_000, lastMessageAt: 35_000, lastTickerAt: 5_000, staleMs: 30_000, staleTickerMs: 30_000 })).toBe(true);
    expect(shouldForceReconnect({ nowMs: 40_000, lastMessageAt: 35_000, lastTickerAt: 35_000, staleMs: 30_000, staleTickerMs: 30_000 })).toBe(false);
  });
});

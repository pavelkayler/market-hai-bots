import { describe, expect, it } from 'vitest';

import { BotEngine } from '../src/bot/botEngine.js';

describe('v2 determinism', () => {
  it('throttles blackout cancel/close actions to once per 10s window', async () => {
    let now = 1_700_000_000_000;
    const calls = { cancel: 0, close: 0 };
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => {},
      emitOrderUpdate: () => {},
      emitPositionUpdate: () => {},
      emitQueueUpdate: () => {},
      demoTradeClient: {
        cancelOrder: async () => {
          calls.cancel += 1;
          return {} as never;
        },
        closePositionMarket: async () => {
          calls.close += 1;
          return {} as never;
        }
      } as never
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ mode: 'demo', direction: 'both', tf: 1, priceUpThrPct: 0.5, oiUpThrPct: 3, signalCounterMin: 2, signalCounterMax: 3 } as never);

    const market = {
      markPrice: 100,
      openInterestValue: 1000,
      ts: now,
      fundingRate: 0.01,
      nextFundingTimeMs: now + 20 * 60_000,
      lastPrice: 100,
      bid: 99.9,
      ask: 100.1,
      spreadBps: 20,
      lastTickTs: now
    };

    engine.onMarketUpdate('BTCUSDT', market);
    engine.onMarketUpdate('BTCUSDT', { ...market, ts: now + 1000, lastTickTs: now + 1000 });
    engine.onMarketUpdate('BTCUSDT', { ...market, ts: now + 2000, lastTickTs: now + 2000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.cancel).toBe(1);
    expect(calls.close).toBe(1);

    now += 11_000;
    engine.onMarketUpdate('BTCUSDT', { ...market, ts: now, lastTickTs: now });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.cancel).toBe(2);
    expect(calls.close).toBe(2);
  });

  it('killSwitch remains stable across repeated calls', async () => {
    const now = 1_700_000_000_000;
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => {},
      emitOrderUpdate: () => {},
      emitPositionUpdate: () => {},
      emitQueueUpdate: () => {}
    });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ mode: 'paper', direction: 'both', tf: 1, priceUpThrPct: 0.5, oiUpThrPct: 3, signalCounterMin: 2, signalCounterMax: 3 } as never);

    const first = await engine.killSwitch(() => undefined);
    const second = await engine.killSwitch(() => undefined);

    expect(first.activeOrdersRemaining).toBe(0);
    expect(first.openPositionsRemaining).toBe(0);
    expect(second.activeOrdersRemaining).toBe(0);
    expect(second.openPositionsRemaining).toBe(0);
    expect(engine.getState().paused).toBe(true);
  });
});

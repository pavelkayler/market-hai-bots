import { describe, expect, it } from 'vitest';

import { BotEngine, type SignalPayload } from '../src/bot/botEngine.js';

const defaultConfig = {
  mode: 'paper' as const,
  direction: 'long' as const,
  tf: 1 as const,
  holdSeconds: 1,
  priceUpThrPct: 1,
  oiUpThrPct: 1,
  marginUSDT: 100,
  leverage: 2,
  tpRoiPct: 1,
  slRoiPct: 1
};

describe('BotEngine', () => {
  it('initializes baseline on first market tick after start', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: (payload) => signals.push(payload) });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 100,
      openInterestValue: 1000,
      ts: now
    });

    expect(signals).toEqual([]);
    expect(engine.getSymbolState('BTCUSDT')?.baseline).toEqual({
      basePrice: 100,
      baseOiValue: 1000,
      baseTs: now
    });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });

  it('emits signal:new after holdSeconds when condition remains true', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: (payload) => signals.push(payload) });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 100,
      openInterestValue: 1000,
      ts: now
    });

    now += 10;
    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 102,
      openInterestValue: 1020,
      ts: now
    });

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('HOLDING_LONG');

    now += 1100;
    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 103,
      openInterestValue: 1030,
      ts: now
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'LONG',
      markPrice: 103,
      oiValue: 1030
    });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });
});

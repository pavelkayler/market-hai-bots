import { describe, expect, it } from 'vitest';

import { BotEngine, type BotConfig, type OrderUpdatePayload, type PositionUpdatePayload, type SignalPayload } from '../src/bot/botEngine.js';

const defaultConfig: BotConfig = {
  mode: 'paper',
  direction: 'long',
  tf: 1,
  holdSeconds: 1,
  priceUpThrPct: 1,
  oiUpThrPct: 1,
  marginUSDT: 100,
  leverage: 2,
  tpRoiPct: 1,
  slRoiPct: 1
};

describe('BotEngine paper execution', () => {
  it('places ENTRY_PENDING paper order after confirmed signal', () => {
    const signals: SignalPayload[] = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: (payload) => positionUpdates.push(payload)
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(signals).toHaveLength(1);
    expect(symbolState?.fsmState).toBe('ENTRY_PENDING');
    expect(symbolState?.pendingOrder).toMatchObject({ symbol: 'BTCUSDT', side: 'Buy', limitPrice: 103 });
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].status).toBe('PLACED');
    expect(positionUpdates).toEqual([]);
  });

  it('fills LONG when mark drops below limit and opens position', () => {
    const orderUpdates: OrderUpdatePayload[] = [];
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: (payload) => positionUpdates.push(payload)
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.5, openInterestValue: 1035, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('POSITION_OPEN');
    expect(symbolState?.position?.entryPrice).toBe(103);
    expect(orderUpdates.map((u) => u.status)).toEqual(['PLACED', 'FILLED']);
    expect(positionUpdates[0].status).toBe('OPEN');
  });

  it('closes LONG on TP and resets baseline and state', () => {
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload)
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.9, openInterestValue: 1040, ts: now });

    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103.8, openInterestValue: 1050, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('IDLE');
    expect(symbolState?.position).toBeNull();
    expect(symbolState?.overrideGateOnce).toBe(true);
    expect(symbolState?.baseline).toEqual({
      basePrice: 103.8,
      baseOiValue: 1050,
      baseTs: now
    });
    expect(positionUpdates[positionUpdates.length - 1]).toMatchObject({ status: 'CLOSED', exitPrice: 103.8 });
  });

  it('auto-cancels pending order after 1 hour and resets baseline', () => {
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    now += 60 * 60 * 1000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1100, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('IDLE');
    expect(symbolState?.pendingOrder).toBeNull();
    expect(symbolState?.overrideGateOnce).toBe(true);
    expect(orderUpdates.map((u) => u.status)).toEqual(['PLACED', 'EXPIRED']);
  });
});

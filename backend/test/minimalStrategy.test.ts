import { describe, expect, it } from 'vitest';
import { BotEngine, normalizeBotConfig } from '../src/bot/botEngine.js';

const baseRaw = {
  mode: 'paper',
  direction: 'both',
  tfMinutes: 1,
  priceUpThrPct: 1,
  oiUpThrPct: 1,
  marginUSDT: 100,
  leverage: 2,
  tpRoiPct: 1,
  slRoiPct: 1,
  minTriggerCount: 2,
  maxTriggerCount: 3,
  maxSecondsIntoCandle: 120
};

describe('minimal strategy behavior', () => {
  it('supports tf 10/15 and trigger aliases in normalize config', () => {
    const cfg10 = normalizeBotConfig({ ...baseRaw, tfMinutes: 10 });
    const cfg15 = normalizeBotConfig({ ...baseRaw, tfMinutes: 15 });
    expect(cfg10?.tf).toBe(10);
    expect(cfg15?.tf).toBe(15);
    expect(cfg10?.signalCounterMin).toBe(2);
    expect(cfg10?.signalCounterMax).toBe(3);
  });

  it('resets signal counter exactly at 00:00 MSK boundary', () => {
    let now = Date.UTC(2025, 0, 1, 20, 59, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(normalizeBotConfig(baseRaw)!);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, fundingRate: 0.001, nextFundingTimeMs: now + 60_000, lastPrice: 100, bid: 99.9, ask: 100.1, spreadBps: 20, lastTickTs: now });
    const stateBefore = engine.getSymbolState('BTCUSDT');
    if (!stateBefore) throw new Error('missing state');
    stateBefore.signalEvents24h = [now - 1_000];
    stateBefore.lastSignalCount24h = 1;
    stateBefore.lastSignalAtMs = now - 1_000;

    now = Date.UTC(2025, 0, 1, 21, 0, 0);
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, fundingRate: 0.001, nextFundingTimeMs: now + 60_000, lastPrice: 100, bid: 99.9, ask: 100.1, spreadBps: 20, lastTickTs: now });

    const stateAfter = engine.getSymbolState('BTCUSDT');
    expect(stateAfter?.signalEvents24h).toEqual([]);
    expect(stateAfter?.lastSignalCount24h).toBe(0);
    expect(stateAfter?.lastSignalAtMs).toBeNull();
  });

  it('marks symbol as MISSING when next funding time is stale', () => {
    const now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(normalizeBotConfig(baseRaw)!);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, fundingRate: 0.001, nextFundingTimeMs: now - 6 * 60_000, lastPrice: 100, bid: 99.9, ask: 100.1, spreadBps: 20, lastTickTs: now });

    expect(engine.getSymbolState('BTCUSDT')?.tradingAllowed).toBe('MISSING');
  });

  it('marks symbol as MISSING when funding is unavailable', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(normalizeBotConfig(baseRaw)!);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, fundingRate: null, nextFundingTimeMs: null, lastPrice: null, bid: null, ask: null, spreadBps: null, lastTickTs: now });

    expect(engine.getSymbolState('BTCUSDT')?.tradingAllowed).toBe('MISSING');
    expect(engine.getSymbolState('BTCUSDT')?.lastSignalCount24h).toBe(0);
  });

  it('keeps funding status out of permanent funding_missing when funding is present', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(
      normalizeBotConfig({
        ...baseRaw,
        tfMinutes: 1,
        minTriggerCount: 1,
        maxTriggerCount: 3,
        signalCounterThreshold: 1,
        priceUpThrPct: 0.001,
        oiUpThrPct: 0.001,
        minFundingAbs: 0,
        maxSecondsIntoCandle: 120
      })!
    );

    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 100,
      openInterestValue: 1_000_000,
      ts: now,
      fundingRate: 0.0003,
      nextFundingTimeMs: now + 60 * 60_000,
      lastPrice: 100,
      bid: 99.99,
      ask: 100.01,
      spreadBps: 2,
      lastTickTs: now
    });
    now += 70_000;
    engine.onMarketUpdate('BTCUSDT', {
      markPrice: 100.2,
      openInterestValue: 1_002_000,
      ts: now,
      fundingRate: 0.0003,
      nextFundingTimeMs: now + 60 * 60_000,
      lastPrice: 100.2,
      bid: 100.19,
      ask: 100.21,
      spreadBps: 2,
      lastTickTs: now
    });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.tradingAllowed).not.toBe('MISSING');
    expect(symbolState?.lastNoEntryReasons.some((reason) => reason.code === 'funding_missing')).toBe(false);
  });
});

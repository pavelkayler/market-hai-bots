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

  it('marks symbol as MISSING when funding is unavailable', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(normalizeBotConfig(baseRaw)!);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, fundingRate: null, nextFundingTimeMs: null, lastPrice: null, bid: null, ask: null, spreadBps: null, lastTickTs: now });

    expect(engine.getSymbolState('BTCUSDT')?.tradingAllowed).toBe('MISSING');
    expect(engine.getSymbolState('BTCUSDT')?.lastSignalCount24h).toBe(0);
  });
});

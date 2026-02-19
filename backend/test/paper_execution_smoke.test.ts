import { describe, expect, it } from 'vitest';

import { BotEngine, type BotConfig } from '../src/bot/botEngine.js';

const baseConfig: BotConfig = {
  mode: 'paper',
  direction: 'both',
  bothTieBreak: 'shortPriority',
  tf: 1,
  holdSeconds: 1,
  signalCounterThreshold: 1,
  priceUpThrPct: 0.5,
  oiUpThrPct: 0.5,
  minFundingAbs: 0,
  oiCandleThrPct: 0,
  marginUSDT: 100,
  leverage: 2,
  tpRoiPct: 5,
  slRoiPct: 5,
  entryOffsetPct: 0,
  maxActiveSymbols: 5,
  dailyLossLimitUSDT: 0,
  maxConsecutiveLosses: 0,
  trendTfMinutes: 5,
  trendLookbackBars: 20,
  trendMinMovePct: 0.2,
  confirmWindowBars: 2,
  confirmMinContinuationPct: 0,
  impulseMaxAgeBars: 2,
  requireOiTwoCandles: false,
  maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  maxSpreadBps: 35,
  maxTickStalenessMs: 2500,
  minNotionalUSDT: 5,
  paperEntrySlippageBps: 0,
  paperExitSlippageBps: 0,
  paperPartialFillPct: 100,
  signalCounterMin: 1,
  signalCounterMax: 3,
  strategyMode: 'IMPULSE',
  autoTuneEnabled: false,
  autoTuneScope: 'GLOBAL'
};

function seedOrder(engine: BotEngine, symbol: string, nowRef: { v: number }) {
  engine.onMarketUpdate(symbol, { markPrice: 100, openInterestValue: 1000, openInterest: 1000, fundingRate: 0.0002, ts: nowRef.v });
  nowRef.v += 60_000;
  engine.onMarketUpdate(symbol, { markPrice: 102, openInterestValue: 1020, openInterest: 1020, fundingRate: 0.0002, ts: nowRef.v });
}

describe('paper execution smoke', () => {
  it('creates open order for confirmed paper signal and then fills into a position', () => {
    const nowRef = { v: Date.UTC(2025, 0, 1, 0, 0, 0) };
    const engine = new BotEngine({ now: () => nowRef.v, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(baseConfig);

    seedOrder(engine, 'BTCUSDT', nowRef);

    expect(engine.getPaperExecution().getOpenOrders()).toHaveLength(1);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');

    nowRef.v += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.999, openInterestValue: 1021, openInterest: 1021, fundingRate: 0.0002, ts: nowRef.v });

    expect(engine.getPaperExecution().getOpenOrders()).toHaveLength(0);
    expect(engine.getPaperExecution().getOpenPositions()).toHaveLength(1);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('POSITION_OPEN');
  });

  it('stop semantics cancel orders but keep positions; reset clears both', async () => {
    const nowRef = { v: Date.UTC(2025, 0, 1, 0, 0, 0) };
    const engine = new BotEngine({ now: () => nowRef.v, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start(baseConfig);

    seedOrder(engine, 'BTCUSDT', nowRef);
    nowRef.v += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.99, openInterestValue: 1022, openInterest: 1022, fundingRate: 0.0002, ts: nowRef.v });
    seedOrder(engine, 'ETHUSDT', nowRef);

    expect(engine.getPaperExecution().getOpenOrders().length).toBeGreaterThan(0);
    expect(engine.getPaperExecution().getOpenPositions().length).toBeGreaterThan(0);

    await engine.cancelAllPendingOrders(() => undefined);
    engine.cancelPaperOpenOrders();
    engine.stop();

    expect(engine.getPaperExecution().getOpenOrders()).toHaveLength(0);
    expect(engine.getPaperExecution().getOpenPositions()).toHaveLength(1);
    expect(engine.getState().running).toBe(false);

    engine.clearPaperExecution();
    engine.resetRuntimeStateForAllSymbols();
    engine.resetStats();
    engine.resetLifecycleRuntime();

    expect(engine.getPaperExecution().getOpenOrders()).toHaveLength(0);
    expect(engine.getPaperExecution().getOpenPositions()).toHaveLength(0);
    expect(engine.getState().running).toBe(false);
    expect(engine.getStats().totalTrades).toBe(0);
  });
});

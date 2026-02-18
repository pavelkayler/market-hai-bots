import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DemoClosedPnlItem, DemoCreateOrderParams, DemoOpenOrder, DemoPosition, IDemoTradeClient } from '../src/bybit/demoTradeClient.js';
import { BotEngine, normalizeBotConfig, type BotConfig, type OrderUpdatePayload, type PositionUpdatePayload, type SignalPayload } from '../src/bot/botEngine.js';
import { PAPER_FEES } from '../src/bot/paperFees.js';
import { FileSnapshotStore } from '../src/bot/snapshotStore.js';

const defaultConfig: BotConfig = {
  mode: 'paper',
  direction: 'long',
  bothTieBreak: 'shortPriority',
  tf: 1,
  holdSeconds: 1,
  signalCounterThreshold: 2,
  priceUpThrPct: 0.5,
  oiUpThrPct: 0.5,
  oiCandleThrPct: 0,
  marginUSDT: 100,
  leverage: 2,
  tpRoiPct: 1,
  slRoiPct: 1,
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
  paperPartialFillPct: 100
};

class FakeDemoTradeClient implements IDemoTradeClient {
  public readonly createCalls: DemoCreateOrderParams[] = [];
  public readonly cancelCalls: Array<{ symbol: string; orderId?: string; orderLinkId?: string }> = [];
  public openOrdersBySymbol = new Map<string, DemoOpenOrder[]>();
  public positionsBySymbol = new Map<string, DemoPosition | null>();
  public blockCreate = false;
  public closedPnlBySymbol = new Map<string, DemoClosedPnlItem[]>();

  async createLimitOrderWithTpSl(params: DemoCreateOrderParams): Promise<{ orderId: string; orderLinkId: string }> {
    this.createCalls.push(params);
    if (this.blockCreate) {
      await new Promise(() => undefined);
    }

    return {
      orderId: `oid-${params.symbol}-${this.createCalls.length}`,
      orderLinkId: params.orderLinkId
    };
  }

  async cancelOrder(params: { symbol: string; orderId?: string; orderLinkId?: string }): Promise<void> {
    this.cancelCalls.push(params);
  }

  async getOpenOrders(symbol: string): Promise<DemoOpenOrder[]> {
    return this.openOrdersBySymbol.get(symbol) ?? [];
  }

  async getPosition(symbol: string): Promise<DemoPosition | null> {
    return this.positionsBySymbol.get(symbol) ?? null;
  }

  async closePositionMarket(): Promise<void> {}

  async getClosedPnl(params: { symbol: string }): Promise<DemoClosedPnlItem[]> {
    return this.closedPnlBySymbol.get(params.symbol) ?? [];
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(signals).toHaveLength(1);
    expect(symbolState?.fsmState).toBe('ENTRY_PENDING');
    expect(symbolState?.pendingOrder).toMatchObject({ symbol: 'BTCUSDT', side: 'Buy', limitPrice: 103 });
    expect(orderUpdates).toHaveLength(1);
    expect(orderUpdates[0].status).toBe('PLACED');
    expect(positionUpdates).toEqual([]);
  });

  it('applies entryOffsetPct to paper entry limit for LONG and keeps mark-cross fill rule', () => {
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, entryOffsetPct: 0.1, signalCounterThreshold: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1010, ts: now });

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    expect(pendingOrder?.limitPrice).toBe(101.898);

    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.9, openInterestValue: 1011, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');

    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.898, openInterestValue: 1012, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('POSITION_OPEN');
    expect(orderUpdates.map((entry) => entry.status)).toEqual(['PLACED', 'FILLED']);
  });



  it('uses lot-size filters for paper qty normalization', () => {
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseEntries([
      {
        symbol: 'BTCUSDT',
        turnover24h: 11000000,
        highPrice24h: 110,
        lowPrice24h: 100,
        vol24hPct: 10,
        forcedActive: false,
        qtyStep: 0.01,
        minOrderQty: 0.01,
        maxOrderQty: null
      }
    ]);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    expect(orderUpdates[0]?.order.qty).toBe(1.94);
  });

  it('skips paper order and logs when normalized qty is below minOrderQty', () => {
    const logs: string[] = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      emitLog: (message) => logs.push(message)
    });

    engine.setUniverseEntries([
      {
        symbol: 'BTCUSDT',
        turnover24h: 11000000,
        highPrice24h: 110,
        lowPrice24h: 100,
        vol24hPct: 10,
        forcedActive: false,
        qtyStep: 0.1,
        minOrderQty: 5,
        maxOrderQty: null
      }
    ]);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
    expect(orderUpdates).toHaveLength(0);
    expect(logs.some((entry) => entry.includes('Skipped BTCUSDT'))).toBe(true);
  });

  it('auto-cancels pending order after 1 hour and resets baseline', () => {
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    now += 60 * 60 * 1000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1100, ts: now });

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
    expect(orderUpdates.map((u) => u.status)).toEqual(['PLACED', 'EXPIRED']);
  });

  it('does not open short entries when direction=long', () => {
    const signals: SignalPayload[] = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'long' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 99, openInterestValue: 990, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98, openInterestValue: 980, ts: now });

    expect(signals).toEqual([]);
    expect(orderUpdates).toEqual([]);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });

  it('does not open long entries when direction=short', () => {
    const signals: SignalPayload[] = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    expect(signals).toEqual([]);
    expect(orderUpdates).toEqual([]);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });

  it('does not trigger short for small negative price move below threshold', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 99.5, openInterestValue: 950, ts: now });

    expect(signals).toHaveLength(0);
  });

  it('triggers continuation short when price and OI thresholds are met', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 950, ts: now });

    expect(signals[0]?.side).toBe('SHORT');
  });

  it('triggers divergence short when price falls and OI rises above threshold', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 1050, ts: now });

    expect(signals[0]?.side).toBe('SHORT');
  });


  it('tags divergence short with entry reason and increments stats reason counter', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'both', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 1050, ts: now });

    expect(signals[0]?.entryReason).toBe('SHORT_DIVERGENCE');
    expect(engine.getSymbolState('BTCUSDT')?.entryReason).toBe('SHORT_DIVERGENCE');
    expect(engine.getStats().reasonCounts.SHORT_DIVERGENCE).toBe(1);
  });



  it('normalizes legacy config with holdSeconds only by applying signalCounterThreshold default', () => {
    const normalized = normalizeBotConfig({
      mode: 'paper',
      direction: 'long',
      tf: 1,
      holdSeconds: 9,
      priceUpThrPct: 1,
      oiUpThrPct: 1,
      marginUSDT: 10,
      leverage: 2,
      tpRoiPct: 1,
      slRoiPct: 1
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.holdSeconds).toBe(9);
    expect(normalized?.signalCounterThreshold).toBe(2);
  });

  it('computes entryOffsetPct=0.01% entry limit from mark for long and short', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const longEngine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });
    longEngine.setUniverseSymbols(['BTCUSDT']);
    longEngine.start({ ...defaultConfig, direction: 'long', signalCounterThreshold: 1, entryOffsetPct: 0.01, priceUpThrPct: 0.1, oiUpThrPct: 0.1 });
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 99, openInterestValue: 1000, ts: now });
    now += 60_000;
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1015, ts: now });
    expect(longEngine.getSymbolState('BTCUSDT')?.pendingOrder?.limitPrice).toBe(99.99);

    let shortNow = Date.UTC(2025, 0, 1, 0, 0, 0);
    const shortEngine = new BotEngine({
      now: () => shortNow,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });
    shortEngine.setUniverseSymbols(['BTCUSDT']);
    shortEngine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, entryOffsetPct: 0.01, priceUpThrPct: 0.5, oiUpThrPct: 4 });
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1000, ts: shortNow });
    shortNow += 60_000;
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 900, ts: shortNow });
    expect(shortEngine.getSymbolState('BTCUSDT')?.pendingOrder?.limitPrice).toBe(100.01);
  });

  it('keeps default BOTH tie-break as shortPriority', () => {
    const normalized = normalizeBotConfig({ ...defaultConfig, direction: 'both' } as unknown as Record<string, unknown>);
    expect(normalized?.bothTieBreak).toBe('shortPriority');
  });

  it('uses longPriority tie-break when both long and short are valid', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: (payload) => signals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'both', bothTieBreak: 'longPriority', signalCounterThreshold: 1, priceUpThrPct: 0, oiUpThrPct: 0 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });

    expect(signals[0]?.side).toBe('LONG');
    expect(signals[0]?.bothCandidate).toMatchObject({ hadBoth: true, chosen: 'long', tieBreak: 'longPriority' });
  });

  it('uses strongerSignal tie-break and stable short fallback on equal edge', () => {
    const strongerSignals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const strongerEngine = new BotEngine({ now: () => now, emitSignal: (payload) => strongerSignals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    strongerEngine.setUniverseSymbols(['BTCUSDT']);
    strongerEngine.start({ ...defaultConfig, direction: 'both', bothTieBreak: 'strongerSignal', signalCounterThreshold: 1, priceUpThrPct: -1, oiUpThrPct: 0 });

    strongerEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    strongerEngine.onMarketUpdate('BTCUSDT', { markPrice: 99.5, openInterestValue: 1000, ts: now });
    expect(strongerSignals[0]?.side).toBe('SHORT');
    expect((strongerSignals[0]?.bothCandidate?.edgeShort ?? 0) > (strongerSignals[0]?.bothCandidate?.edgeLong ?? 0)).toBe(true);

    const tieSignals: SignalPayload[] = [];
    let tieNow = Date.UTC(2025, 0, 1, 2, 0, 0);
    const tieEngine = new BotEngine({ now: () => tieNow, emitSignal: (payload) => tieSignals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    tieEngine.setUniverseSymbols(['BTCUSDT']);
    tieEngine.start({ ...defaultConfig, direction: 'both', bothTieBreak: 'strongerSignal', signalCounterThreshold: 1, priceUpThrPct: 0, oiUpThrPct: 0 });
    tieEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: tieNow });
    tieNow += 60_000;
    tieEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: tieNow });
    expect(tieSignals[0]?.side).toBe('SHORT');
    expect(tieSignals[0]?.bothCandidate?.edgeLong).toBeCloseTo(tieSignals[0]?.bothCandidate?.edgeShort ?? 0, 6);
  });

  it('tracks BOTH tie counters and includes bothCandidate only for hadBoth', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: (payload) => signals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'both', bothTieBreak: 'shortPriority', signalCounterThreshold: 1, priceUpThrPct: 0, oiUpThrPct: 0 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });

    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.5, openInterestValue: 990, ts: now });

    const stats = engine.getStats();
    expect(stats.bothHadBothCount).toBe(1);
    expect(stats.bothChosenShortCount).toBe(1);
    expect(stats.bothChosenLongCount).toBe(0);
    expect(signals[0]?.bothCandidate?.hadBoth).toBe(true);
    expect(signals[1]?.bothCandidate).toBeUndefined();
  });

  it('blocks confirmed entry when spread is above maxSpreadBps', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, maxSpreadBps: 10, maxTickStalenessMs: 0 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, bid: 99.95, ask: 100.05, spreadBps: 10 });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now, bid: 101, ask: 103, spreadBps: 196.08 });

    expect(engine.getSymbolState('BTCUSDT')?.lastNoEntryReasons[0]?.code).toBe('SPREAD_TOO_WIDE');
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });

  it('blocks confirmed entry when last tick is stale', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, maxSpreadBps: 0, maxTickStalenessMs: 1000 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, lastTickTs: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now, lastTickTs: now - 5000 });

    expect(engine.getSymbolState('BTCUSDT')?.lastNoEntryReasons[0]?.code).toBe('TICK_STALE');
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
  });

  it('increments signal-mix counters before liquidity gates block entry', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'both', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4, maxSpreadBps: 10, maxTickStalenessMs: 0 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, bid: 99.95, ask: 100.05, spreadBps: 10 });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 1050, ts: now, bid: 98, ask: 99.5, spreadBps: 151.13 });

    const stats = engine.getStats();
    expect(stats.signalsConfirmed).toBe(1);
    expect(stats.signalsBySide.short).toBe(1);
    expect(stats.signalsByEntryReason.SHORT_DIVERGENCE).toBe(1);
    expect(engine.getSymbolState('BTCUSDT')?.lastNoEntryReasons[0]?.code).toBe('SPREAD_TOO_WIDE');
  });

  it('does not emit short divergence reason when direction=long', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'long', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 1050, ts: now });

    expect(signals).toHaveLength(0);
    expect(engine.getStats().reasonCounts.SHORT_DIVERGENCE).toBe(0);
  });

  it('holding short state keeps position and order empty', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 2, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 950, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('HOLDING_SHORT');
    expect(symbolState?.pendingOrder).toBeNull();
    expect(symbolState?.position).toBeNull();
  });

  it('position open state includes position details', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('POSITION_OPEN');
    expect(symbolState?.position).not.toBeNull();
  });

  it('resets invalid ENTRY_PENDING snapshot state to IDLE without crashing', () => {
    const logs: string[] = [];
    const now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      emitLog: (line) => logs.push(line)
    });

    engine.restoreFromSnapshot({
      savedAt: now,
      paused: false,
      running: true,
      config: { ...defaultConfig, signalCounterThreshold: 1 },
      symbols: {
        BTCUSDT: {
          fsmState: 'ENTRY_PENDING',
          baseline: { basePrice: 100, baseOiValue: 1000, baseTs: now },
          blockedUntilTs: 0,
          overrideGateOnce: false,
          pendingOrder: null,
          position: null,
          demo: null
        }
      }
    });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1001, ts: now });
    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.fsmState).toBe('IDLE');
    expect(logs.some((line) => line.includes('FSM invariant violated'))).toBe(true);
  });

  it('uses signalCounterThreshold with TF-bucket dedup over rolling 24h', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 2, priceUpThrPct: 1, oiUpThrPct: 4 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 950, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.signalEvents).toHaveLength(1);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('HOLDING_SHORT');

    now += 10_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.7, openInterestValue: 949, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.signalEvents).toHaveLength(1);

    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 97.6, openInterestValue: 900, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');

    now += 25 * 60 * 60 * 1000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 950, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.signalEvents).toHaveLength(1);
  });

  it('applies candle-to-candle OI gate for long and short', () => {
    const longSignals: SignalPayload[] = [];
    const shortSignals: SignalPayload[] = [];
    let longNow = Date.UTC(2025, 0, 1, 0, 0, 0);
    const longEngine = new BotEngine({
      now: () => longNow,
      emitSignal: (payload) => longSignals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    longEngine.setUniverseSymbols(['BTCUSDT']);
    longEngine.start({ ...defaultConfig, direction: 'long', signalCounterThreshold: 1, oiCandleThrPct: 10, priceUpThrPct: 1, oiUpThrPct: 1 });
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 100, ts: longNow });
    longNow += 60_000;
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 101.2, openInterestValue: 115, ts: longNow });
    expect(longSignals).toHaveLength(1);

    let shortNow = Date.UTC(2025, 0, 1, 0, 0, 0);
    const shortEngine = new BotEngine({
      now: () => shortNow,
      emitSignal: (payload) => shortSignals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    shortEngine.setUniverseSymbols(['BTCUSDT']);
    shortEngine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, oiCandleThrPct: 10, priceUpThrPct: 1, oiUpThrPct: 1 });
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 100, ts: shortNow });
    shortNow += 60_000;
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 95, ts: shortNow });
    expect(shortSignals).toHaveLength(0);
  });

  it('tracks bot stats for one winning and one losing close', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start(defaultConfig);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now + 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1030, ts: now + 2 });

    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now + 1 });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now + 2 });

    const stats = engine.getStats();
    expect(stats.totalTrades).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winratePct).toBe(50);
    expect(stats.pnlUSDT).toBeLessThan(0);
  });

  it('tracks long/short breakdown for closed trades', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start({ ...defaultConfig, direction: 'both', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1030, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1035, ts: now });

    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 98, openInterestValue: 980, ts: now });
    now += 1;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 99, openInterestValue: 970, ts: now });
    now += 1;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 960, ts: now });

    const stats = engine.getStats();
    expect(stats.long.trades).toBe(1);
    expect(stats.long.wins).toBe(1);
    expect(stats.long.losses).toBe(0);
    expect(stats.long.winratePct).toBe(100);
    expect(stats.short.trades).toBe(1);
    expect(stats.short.wins).toBe(0);
    expect(stats.short.losses).toBe(1);
    expect(stats.short.winratePct).toBe(0);
  });

  it('maxActiveSymbols prevents a second order when limit=1', () => {
    const logs: string[] = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      emitLog: (message) => logs.push(message)
    });

    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start({ ...defaultConfig, maxActiveSymbols: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    expect(orderUpdates.filter((entry) => entry.status === 'PLACED')).toHaveLength(1);
    expect(engine.getSymbolState('ETHUSDT')?.fsmState).toBe('IDLE');
    expect(logs).toContain('Guardrail: maxActiveSymbols reached');
  });

  it('dailyLossLimit triggers pause after a losing close', () => {
    let now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, dailyLossLimitUSDT: 0.1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });

    expect(engine.getState()).toMatchObject({ paused: true, running: true });
    expect(engine.getStats().guardrailPauseReason).toBe('DAILY_LOSS_LIMIT');
  });


  it('emits guardrail paused callback and blocks new entries while paused', () => {
    let now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const guardrailEvents: Array<{ reason: string }> = [];
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      onGuardrailPaused: (payload) => guardrailEvents.push({ reason: payload.reason })
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, dailyLossLimitUSDT: 0.05 });
    const mutable = engine as unknown as {
      recordClosedTrade: (symbol: string, side: 'LONG' | 'SHORT', gross: number, fees: number, net: number, reason: string) => void;
    };
    mutable.recordClosedTrade('BTCUSDT', 'LONG', 0, 0.06, -0.06, 'OTHER');

    expect(engine.getState()).toMatchObject({ paused: true, running: true });
    expect(engine.getStats().guardrailPauseReason).toBe('DAILY_LOSS_LIMIT');
    expect(guardrailEvents).toEqual([{ reason: 'DAILY_LOSS_LIMIT' }]);

    const beforeAttempts = engine.getSymbolState('BTCUSDT')?.signalsAttempted ?? 0;
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    const afterAttempts = engine.getSymbolState('BTCUSDT')?.signalsAttempted ?? 0;

    expect(afterAttempts).toBe(beforeAttempts);
  });

  it('maxConsecutiveLosses triggers pause after N losses', () => {
    let now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start({ ...defaultConfig, maxConsecutiveLosses: 2 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });

    expect(engine.getState().paused).toBe(false);

    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });

    expect(engine.getState()).toMatchObject({ paused: true, running: true });
    expect(engine.getStats().lossStreak).toBe(2);
    expect(engine.getStats().guardrailPauseReason).toBe('MAX_CONSECUTIVE_LOSSES');
  });

});

describe('BotEngine demo execution', () => {
  it('enqueues demo order then emits PLACED and ENTRY_PENDING', async () => {
    const demoClient = new FakeDemoTradeClient();
    const queueUpdates: Array<{ depth: number }> = [];
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: (payload) => queueUpdates.push(payload)
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    await flush();

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');
    expect(orderUpdates.map((entry) => entry.status)).toEqual(['PLACED']);
    expect(queueUpdates.some((entry) => entry.depth > 0)).toBe(true);
  });



  it('normalizes demo qty before REST placement', async () => {
    const demoClient = new FakeDemoTradeClient();
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseEntries([
      {
        symbol: 'BTCUSDT',
        turnover24h: 11000000,
        highPrice24h: 110,
        lowPrice24h: 100,
        vol24hPct: 10,
        forcedActive: false,
        qtyStep: 0.01,
        minOrderQty: 0.01,
        maxOrderQty: null
      }
    ]);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    expect(demoClient.createCalls[0]?.qty).toBe('1.94');
  });

  it('manual cancel before send removes queued job and resets to IDLE', async () => {
    const demoClient = new FakeDemoTradeClient();
    demoClient.blockCreate = true;
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);

    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT', 'ETHUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    const cancelled = await engine.cancelPendingOrder('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    expect(cancelled).toBe(true);
    expect(engine.getSymbolState('ETHUSDT')?.fsmState).toBe('IDLE');
    expect(engine.getSymbolState('ETHUSDT')?.overrideGateOnce).toBe(true);
  });

  it('manual cancel after send calls demo cancel and resets baseline/override', async () => {
    const demoClient = new FakeDemoTradeClient();
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);

    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    const cancelled = await engine.cancelPendingOrder('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    expect(cancelled).toBe(true);
    expect(demoClient.cancelCalls).toHaveLength(1);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
    expect(engine.getSymbolState('BTCUSDT')?.overrideGateOnce).toBe(true);
  });

  it('auto-expire after 1 hour triggers cancel call', async () => {
    const demoClient = new FakeDemoTradeClient();
    const orderUpdates: OrderUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    now += 60 * 60 * 1000 + 1;
    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 104, openInterestValue: 1050, ts: now } });

    expect(demoClient.cancelCalls).toHaveLength(1);
    expect(orderUpdates.map((entry) => entry.status)).toContain('EXPIRED');
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
    expect(engine.getSymbolState('BTCUSDT')?.overrideGateOnce).toBe(true);
  });

  it('uses offset limit price for demo create order payload', async () => {
    const demoClient = new FakeDemoTradeClient();
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo', entryOffsetPct: 0.1, signalCounterThreshold: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1010, ts: now });
    await flush();

    expect(demoClient.createCalls).toHaveLength(1);
    expect(demoClient.createCalls[0].price).toBe('101.898');
  });

  it('polling transitions pending to filled to position open', async () => {
    const demoClient = new FakeDemoTradeClient();
    const orderUpdates: OrderUpdatePayload[] = [];
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: (payload) => orderUpdates.push(payload),
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    demoClient.openOrdersBySymbol.set('BTCUSDT', [
      {
        symbol: 'BTCUSDT',
        orderStatus: 'Filled',
        orderId: pendingOrder?.orderId,
        orderLinkId: pendingOrder?.orderLinkId
      }
    ]);

    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 103, openInterestValue: 1030, ts: now } });

    expect(orderUpdates.map((entry) => entry.status)).toContain('FILLED');
    expect(positionUpdates.map((entry) => entry.status)).toContain('OPEN');
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('POSITION_OPEN');
  });

  it('keeps POSITION_OPEN when position/list reports size > 0 even with no open orders', async () => {
    const demoClient = new FakeDemoTradeClient();
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    demoClient.openOrdersBySymbol.set('BTCUSDT', [
      {
        symbol: 'BTCUSDT',
        orderStatus: 'Filled',
        orderId: pendingOrder?.orderId,
        orderLinkId: pendingOrder?.orderLinkId
      }
    ]);

    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 103, openInterestValue: 1030, ts: now } });

    demoClient.openOrdersBySymbol.set('BTCUSDT', []);
    demoClient.positionsBySymbol.set('BTCUSDT', {
      symbol: 'BTCUSDT',
      size: 1.2,
      entryPrice: 103,
      side: 'Buy',
      positionIdx: 0,
      leverage: 2,
      unrealisedPnl: 1.5
    });

    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 104, openInterestValue: 1035, ts: now + 1000 } });

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('POSITION_OPEN');
    expect(positionUpdates.filter((entry) => entry.status === 'CLOSED')).toHaveLength(0);
  });

  it('closes POSITION_OPEN when position/list reports size = 0 and resets baseline override', async () => {
    const demoClient = new FakeDemoTradeClient();
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo' });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    demoClient.openOrdersBySymbol.set('BTCUSDT', [
      {
        symbol: 'BTCUSDT',
        orderStatus: 'Filled',
        orderId: pendingOrder?.orderId,
        orderLinkId: pendingOrder?.orderLinkId
      }
    ]);

    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 103, openInterestValue: 1030, ts: now } });

    const closeMarket = { markPrice: 99, openInterestValue: 900, ts: now + 1000 };
    demoClient.positionsBySymbol.set('BTCUSDT', {
      symbol: 'BTCUSDT',
      size: 0,
      entryPrice: 103,
      side: 'Buy',
      positionIdx: 0
    });

    await engine.pollDemoOrders({ BTCUSDT: closeMarket });

    const symbolState = engine.getSymbolState('BTCUSDT');
    expect(symbolState?.fsmState).toBe('IDLE');
    expect(symbolState?.overrideGateOnce).toBe(true);
    expect(symbolState?.baseline).toEqual({
      basePrice: closeMarket.markPrice,
      baseOiValue: closeMarket.openInterestValue,
      baseTs: closeMarket.ts
    });
    expect(positionUpdates[positionUpdates.length - 1]).toMatchObject({
      status: 'CLOSED',
      closeReason: 'SL',
      exitPrice: closeMarket.markPrice
    });
    expect(positionUpdates[positionUpdates.length - 1]?.impact?.netPnlUSDT ?? 0).not.toBe(0);
    expect(positionUpdates[positionUpdates.length - 1]?.entry?.spreadBpsAtEntry).not.toBeUndefined();
    expect(positionUpdates[positionUpdates.length - 1]?.exit?.spreadBpsAtExit).not.toBeUndefined();
  });

  it('uses closed-pnl payload for demo close accounting best-effort', async () => {
    const demoClient = new FakeDemoTradeClient();
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      demoTradeClient: demoClient,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo', signalCounterThreshold: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1010, ts: now });
    await flush();

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    demoClient.openOrdersBySymbol.set('BTCUSDT', [
      { symbol: 'BTCUSDT', orderStatus: 'Filled', orderId: pendingOrder?.orderId, orderLinkId: pendingOrder?.orderLinkId }
    ]);
    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 102, openInterestValue: 1010, ts: now } });

    const opened = engine.getSymbolState('BTCUSDT')?.position;
    expect(opened).toBeTruthy();
    if (!opened) {
      return;
    }

    demoClient.closedPnlBySymbol.set('BTCUSDT', [
      {
        symbol: 'BTCUSDT',
        side: 'Buy',
        qty: opened.qty,
        avgEntryPrice: opened.entryPrice,
        avgExitPrice: opened.tpPrice,
        updatedTime: opened.openedTs + 1_000
      }
    ]);
    demoClient.positionsBySymbol.set('BTCUSDT', null);

    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 101, openInterestValue: 1008, ts: now + 1_000 } });

    const closed = positionUpdates.find((entry) => entry.status === 'CLOSED');
    expect(closed?.closeReason).toBe('TP');
    expect(closed?.realizedNetPnlUSDT ?? 0).not.toBe(0);
    expect(closed?.feesUSDT ?? 0).toBeGreaterThan(0);
  });

});


describe('BotEngine snapshot + pause/resume', () => {
  it('writes runtime snapshot with pending paper order', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-test-'));
    const runtimePath = path.join(tempDir, 'data', 'runtime.json');
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      snapshotStore: new FileSnapshotStore(runtimePath),
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    const raw = await readFile(runtimePath, 'utf-8');
    const parsed = JSON.parse(raw) as { symbols: Record<string, { pendingOrder: unknown }> };
    expect(parsed.symbols.BTCUSDT.pendingOrder).toBeTruthy();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists stats in snapshot and restores them', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-stats-test-'));
    const runtimePath = path.join(tempDir, 'data', 'runtime.json');
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);

    const writer = new BotEngine({
      now: () => now,
      snapshotStore: new FileSnapshotStore(runtimePath),
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    writer.setUniverseSymbols(['BTCUSDT']);
    writer.start(defaultConfig);
    writer.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    writer.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    writer.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    writer.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now + 1 });
    writer.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1030, ts: now + 2 });

    const reader = new BotEngine({
      snapshotStore: new FileSnapshotStore(runtimePath),
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    const snapshot = new FileSnapshotStore(runtimePath).load();
    expect(snapshot?.stats?.totalTrades).toBe(1);
    expect(snapshot?.stats?.wins).toBe(1);
    expect(snapshot?.stats?.long.trades).toBe(1);

    if (snapshot) {
      reader.restoreFromSnapshot(snapshot);
    }
    expect(reader.getStats().totalTrades).toBe(1);
    expect(reader.getStats().wins).toBe(1);
    expect(reader.getStats().long.trades).toBe(1);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('resetStats clears counters', () => {
    const engine = new BotEngine({
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.resetStats();
    expect(engine.getStats()).toMatchObject({
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winratePct: 0,
      pnlUSDT: 0,
      avgWinUSDT: null,
      avgLossUSDT: null
    });
  });

  it('restores symbol runtime from loaded snapshot', () => {
    const now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const snapshotStore = {
      load: () => null,
      save: () => undefined,
      clear: () => undefined
    };
    const snapshot = {
      savedAt: now,
      paused: true,
      running: true,
      config: defaultConfig,
      symbols: {
        BTCUSDT: {
          fsmState: 'ENTRY_PENDING' as const,
          baseline: { basePrice: 100, baseOiValue: 1000, baseTs: now },
          blockedUntilTs: 0,
          overrideGateOnce: false,
          pendingOrder: {
            symbol: 'BTCUSDT',
            side: 'Buy' as const,
            limitPrice: 100,
            qty: 1,
            placedTs: now,
            expiresTs: now + 1000,
            sentToExchange: true
          },
          position: null,
          demo: null
        }
      }
    };

    const engine = new BotEngine({
      snapshotStore,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.restoreFromSnapshot(snapshot);
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');
    expect(engine.getState()).toMatchObject({ paused: true, running: false, hasSnapshot: true });
  });

  it('tracks active uptime across start/pause/resume/stop', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.start(defaultConfig);
    now += 5_000;
    expect(engine.getState().uptimeMs).toBe(5_000);

    engine.pause();
    now += 5_000;
    expect(engine.getState().uptimeMs).toBe(5_000);

    engine.resume(true);
    now += 2_000;
    expect(engine.getState().uptimeMs).toBe(7_000);

    engine.stop();
    now += 3_000;
    expect(engine.getState().uptimeMs).toBe(7_000);
  });

  it('pause stops new signals but allows paper TP/SL close, and resume re-enables generation', () => {
    const signals: SignalPayload[] = [];
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start(defaultConfig);
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    engine.pause();
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now + 1 });
    expect(signals).toHaveLength(1);

    engine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1030, ts: now + 2 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100.4, openInterestValue: 1030, ts: now + 3 });
    expect(positionUpdates.map((u) => u.status)).toContain('CLOSED');

    engine.resume(true);
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 105, openInterestValue: 1300, ts: now });
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');
  });

  it('activity metrics are always numeric across paper lifecycle states', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    const fresh = engine.getState();
    expect(fresh.queueDepth).toBe(0);
    expect(fresh.activeOrders).toBe(0);
    expect(fresh.openPositions).toBe(0);

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, maxActiveSymbols: 9_999, signalCounterThreshold: 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1_000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1_020, ts: now });

    const pending = engine.getState();
    expect(pending.activeOrders).toBe(1);
    expect(pending.openPositions).toBe(0);

    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1_021, ts: now });
    const open = engine.getState();
    expect(open.activeOrders).toBe(0);
    expect(open.openPositions).toBe(1);

    engine.pause();
    const paused = engine.getState();
    expect(paused.queueDepth).toBe(0);
    expect(paused.activeOrders).toBe(0);
    expect(paused.openPositions).toBe(1);

    engine.resume(true);
    const resumed = engine.getState();
    expect(resumed.queueDepth).toBe(0);
    expect(resumed.activeOrders).toBe(0);
    expect(resumed.openPositions).toBe(1);

    const killResult = await engine.killSwitch(() => ({ markPrice: 101, openInterestValue: 1_021, ts: now }));
    expect(killResult.cancelledOrders).toBe(0);
    expect(killResult.closedPositions).toBe(1);
    const killed = engine.getState();
    expect(killed.queueDepth).toBe(0);
    expect(killed.activeOrders).toBe(0);
    expect(killed.openPositions).toBe(0);
  });

  it('demo activity metrics track queue depth and open positions', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const client = new FakeDemoTradeClient();
    client.blockCreate = true;
    const queueDepthEvents: number[] = [];
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: (payload) => queueDepthEvents.push(payload.depth),
      demoTradeClient: client
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo', signalCounterThreshold: 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1_000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1_020, ts: now });

    const queued = engine.getState();
    expect(queued.queueDepth).toBeGreaterThan(0);
    expect(queued.activeOrders).toBe(1);
    expect(queued.openPositions).toBe(0);
    expect(queueDepthEvents.some((depth) => depth > 0)).toBe(true);

    client.blockCreate = false;
    await flush();

    const pendingOrder = engine.getSymbolState('BTCUSDT')?.pendingOrder;
    expect(pendingOrder).toBeTruthy();
    client.openOrdersBySymbol.set('BTCUSDT', [
      {
        symbol: 'BTCUSDT',
        orderId: pendingOrder?.orderId ?? 'oid-BTCUSDT-1',
        orderLinkId: pendingOrder?.orderLinkId ?? null,
        side: 'Buy',
        qty: String(pendingOrder?.qty ?? 1),
        price: String(pendingOrder?.limitPrice ?? 101),
        orderStatus: 'Filled'
      }
    ]);

    await engine.pollDemoOrders({
      BTCUSDT: {
        markPrice: 102,
        openInterestValue: 1_020,
        ts: now
      }
    });

    const withPosition = engine.getState();
    expect(withPosition.activeOrders).toBe(0);
    expect(withPosition.openPositions).toBe(1);
  });

  it('demo killSwitch keeps local position when close fails', async () => {
    const now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const client = new FakeDemoTradeClient();
    client.closePositionMarket = async () => {
      throw new Error('demo close failed');
    };

    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      demoTradeClient: client
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, mode: 'demo', signalCounterThreshold: 1 });

    const symbolState = (engine as unknown as {
      symbols: Map<string, { position?: Record<string, unknown> | null; fsmState?: string }>;
    }).symbols.get('BTCUSDT');
    symbolState.position = {
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      tpPrice: 101,
      slPrice: 99,
      openedTs: now
    };
    symbolState.fsmState = 'POSITION_OPEN';

    const result = await engine.killSwitch(() => ({ markPrice: 100, openInterestValue: 1_000, ts: now }));
    expect(result.openPositionsRemaining).toBe(1);
    expect(result.warning).toContain('Demo close failed');
    expect(engine.getSymbolState('BTCUSDT')?.position).toBeTruthy();
  });

  it('demo killSwitch confirms close after polling and clears warning', async () => {
    let now = Date.UTC(2025, 0, 1, 0, 1, 0);
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number) => {
      now += Number(delay ?? 0);
      handler();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;

    try {
      const client = new FakeDemoTradeClient();
      let pollCount = 0;
      client.getPosition = async () => {
        pollCount += 1;
        if (pollCount < 4) {
          return { symbol: 'BTCUSDT', side: 'Buy', size: 1, entryPrice: 100, positionIdx: 1 };
        }
        return null;
      };

      const engine = new BotEngine({
        now: () => now,
        emitSignal: () => undefined,
        emitOrderUpdate: () => undefined,
        emitPositionUpdate: () => undefined,
        emitQueueUpdate: () => undefined,
        demoTradeClient: client
      });

      engine.setUniverseSymbols(['BTCUSDT']);
      engine.start({ ...defaultConfig, mode: 'demo', signalCounterThreshold: 1 });

      const symbolState = (engine as unknown as {
        symbols: Map<string, { position?: Record<string, unknown> | null; fsmState?: string }>;
      }).symbols.get('BTCUSDT');
      symbolState.position = {
        symbol: 'BTCUSDT',
        side: 'LONG',
        qty: 1,
        entryPrice: 100,
        tpPrice: 101,
        slPrice: 99,
        openedTs: now
      };
      symbolState.fsmState = 'POSITION_OPEN';

      const result = await engine.killSwitch(() => ({ markPrice: 100, openInterestValue: 1_000, ts: now }));
      expect(result.openPositionsRemaining).toBe(0);
      expect(result.warning).toBeNull();
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});


describe('BotEngine payload validation', () => {
  it('rejects demo order payload that cannot be rounded to qtyStep', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const client = new FakeDemoTradeClient();
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      demoTradeClient: client
    });

    engine.setUniverseEntries([
      {
        symbol: 'BTCUSDT',
        turnover24h: 11000000,
        highPrice24h: 110,
        lowPrice24h: 100,
        vol24hPct: 10,
        forcedActive: false,
        qtyStep: 0.1,
        minOrderQty: 10,
        maxOrderQty: null
      }
    ]);
    engine.start({ ...defaultConfig, mode: 'demo', marginUSDT: 5, leverage: 1, signalCounterThreshold: 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1010, ts: now });

    const symbol = engine.getSymbolState('BTCUSDT');
    expect(symbol?.fsmState).toBe('IDLE');
    expect(client.createCalls).toHaveLength(0);
  });
});

describe('BotEngine per-symbol stats and candle OI', () => {
  it('aggregates per-symbol stats and side breakdown on close', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, tpRoiPct: 0.5, slRoiPct: 0.5 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1100, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1101, ts: now }); // fill
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1102, ts: now }); // close win

    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 105, openInterestValue: 1200, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 105, openInterestValue: 1201, ts: now }); // fill
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1190, ts: now }); // close loss

    const row = engine.getStats().perSymbol?.find((entry) => entry.symbol === 'BTCUSDT');
    expect(row).toBeTruthy();
    expect(row?.trades).toBe(2);
    expect(row?.wins).toBe(1);
    expect(row?.losses).toBe(1);
    expect(row?.longTrades).toBe(2);
    expect(row?.shortTrades).toBe(0);
    expect(row?.signalsAttempted).toBeGreaterThanOrEqual(2);
    expect(row?.signalsConfirmed).toBeGreaterThanOrEqual(2);
    expect(row?.confirmedBySide.long).toBeGreaterThanOrEqual(2);
    expect(row?.confirmedByEntryReason.LONG_CONTINUATION).toBeGreaterThanOrEqual(2);
    expect((row?.avgHoldMs ?? 0) > 0).toBe(true);
  });


  it('computes priceDeltaPct vs previous TF candle close', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, direction: 'long', priceUpThrPct: 1, oiUpThrPct: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1025, ts: now });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.priceDeltaPct).toBeCloseTo(((102 - 100) / 100) * 100, 6);
  });

  it('computes oiDeltaPct vs previous TF candle OI', () => {
    const signals: SignalPayload[] = [];
    let now = Date.UTC(2025, 0, 1, 1, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: (payload) => signals.push(payload),
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, direction: 'long', priceUpThrPct: 1, oiUpThrPct: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 30_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100.5, openInterestValue: 1020, ts: now }); // prev candle OI anchor
    now += 30_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.8, openInterestValue: 1080, ts: now });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.oiDeltaPct).toBeCloseTo(((1080 - 1020) / 1020) * 100, 6);
  });

  it('SHORT_DIVERGENCE requires OI-up candle gate and SHORT_CONTINUATION requires OI-down candle gate', () => {
    let divNow = Date.UTC(2025, 0, 1, 2, 0, 0);
    const divergenceSignals: SignalPayload[] = [];
    const divergence = new BotEngine({ now: () => divNow, emitSignal: (payload) => divergenceSignals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    divergence.setUniverseSymbols(['BTCUSDT']);
    divergence.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 5 });
    divergence.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: divNow });
    divNow += 60_000;
    divergence.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 1060, ts: divNow });
    expect(divergenceSignals[0]?.entryReason).toBe('SHORT_DIVERGENCE');

    let contNow = Date.UTC(2025, 0, 1, 3, 0, 0);
    const continuationSignals: SignalPayload[] = [];
    const continuation = new BotEngine({ now: () => contNow, emitSignal: (payload) => continuationSignals.push(payload), emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    continuation.setUniverseSymbols(['BTCUSDT']);
    continuation.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, priceUpThrPct: 1, oiUpThrPct: 1, oiCandleThrPct: 5 });
    continuation.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: contNow });
    contNow += 60_000;
    continuation.onMarketUpdate('BTCUSDT', { markPrice: 98.8, openInterestValue: 940, ts: contNow });
    expect(continuationSignals[0]?.entryReason).toBe('SHORT_CONTINUATION');
  });

  it('requireOiTwoCandles enforces sign by entryReason', () => {
    let now = Date.UTC(2025, 0, 1, 4, 0, 0);
    const longEngine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    longEngine.setUniverseSymbols(['BTCUSDT']);
    longEngine.start({ ...defaultConfig, direction: 'long', signalCounterThreshold: 1, requireOiTwoCandles: true, oiCandleThrPct: 1, priceUpThrPct: 0.5, oiUpThrPct: 0.5 });
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1020, ts: now });
    now += 60_000;
    longEngine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1040, ts: now });
    expect(longEngine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');

    let shortNow = Date.UTC(2025, 0, 1, 5, 0, 0);
    const shortEngine = new BotEngine({ now: () => shortNow, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    shortEngine.setUniverseSymbols(['BTCUSDT']);
    shortEngine.start({ ...defaultConfig, direction: 'short', signalCounterThreshold: 1, requireOiTwoCandles: true, oiCandleThrPct: 1, priceUpThrPct: 0.5, oiUpThrPct: 0.5 });
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: shortNow });
    shortNow += 60_000;
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 99, openInterestValue: 980, ts: shortNow });
    shortNow += 60_000;
    shortEngine.onMarketUpdate('BTCUSDT', { markPrice: 98, openInterestValue: 960, ts: shortNow });
    expect(shortEngine.getSymbolState('BTCUSDT')?.fsmState).toBe('ENTRY_PENDING');
  });

  it('tracks oi candle current/previous and deltas across TF buckets', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['ETHUSDT']);
    engine.start({ ...defaultConfig, tf: 3, signalCounterThreshold: 1 });

    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 120_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100.2, openInterestValue: 1100, ts: now });
    expect(engine.getOiCandleSnapshot('ETHUSDT').oiCandleValue).toBe(1100);
    expect(engine.getOiCandleSnapshot('ETHUSDT').oiPrevCandleValue).toBe(1000);

    now += 70_000; // cross 3m boundary
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100.3, openInterestValue: 1200, ts: now });

    const snapshot = engine.getOiCandleSnapshot('ETHUSDT');
    expect(snapshot.oiPrevCandleValue).toBe(1100);
    expect(snapshot.oiCandleValue).toBe(1200);
    expect(snapshot.oiCandleDeltaValue).toBe(100);
    expect(snapshot.oiCandleDeltaPct).toBeCloseTo((100 / 1100) * 100, 6);
  });

  it('restores and resets per-symbol stats via snapshot', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'snapshot-per-symbol-'));
    const store = new FileSnapshotStore(path.join(tempDir, 'runtime.json'));
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);

    const source = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      snapshotStore: store
    });

    source.setUniverseSymbols(['BTCUSDT']);
    source.start({ ...defaultConfig, signalCounterThreshold: 1 });
    source.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    source.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    source.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1021, ts: now });
    now += 1;
    source.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1022, ts: now });

    const saved = store.load();
    expect(saved?.stats?.perSymbol?.length).toBeGreaterThan(0);

    const restored = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      snapshotStore: store
    });

    restored.restoreFromSnapshot(saved!);
    expect(restored.getStats().perSymbol?.[0]?.symbol).toBe('BTCUSDT');

    restored.resetStats();
    expect(restored.getStats().perSymbol).toBeUndefined();

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('BotEngine hardening regressions', () => {
  it('uses SL priority when TP and SL are both crossed in same update', () => {
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, confirmMinContinuationPct: 0 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1021, ts: now });

    const mutable = engine as unknown as { symbols: Map<string, { position: { tpPrice: number; slPrice: number } | null }> };
    const internalPosition = mutable.symbols.get('BTCUSDT')?.position;
    expect(internalPosition).toBeTruthy();
    if (!internalPosition) return;

    const mid = (internalPosition.tpPrice + internalPosition.slPrice) / 2;
    internalPosition.tpPrice = mid;
    internalPosition.slPrice = mid;
    engine.onMarketUpdate('BTCUSDT', { markPrice: mid, openInterestValue: 1022, ts: now + 1 });

    const close = positionUpdates.find((entry) => entry.status === 'CLOSED');
    expect(close?.closeReason).toBe('SL');
  });


  it('computes deterministic LONG close audit fields with maker-entry and taker-exit fees', () => {
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, direction: 'long', marginUSDT: 100, leverage: 1, tpRoiPct: 1, slRoiPct: 1, entryOffsetPct: 0, priceUpThrPct: 0 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1010, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1011, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101, openInterestValue: 1012, ts: now });

    const close = positionUpdates.find((entry) => entry.status === 'CLOSED');
    expect(close).toBeTruthy();
    const entryPrice = close?.position.entryPrice ?? 0;
    const exitPrice = close?.exitPrice ?? 0;
    const qty = close?.position.qty ?? 0;
    const expectedEntryFee = entryPrice * qty * PAPER_FEES.makerFeeRate;
    const expectedExitFee = exitPrice * qty * PAPER_FEES.takerFeeRate;
    const expectedGross = (exitPrice - entryPrice) * qty;
    const expectedNet = expectedGross - expectedEntryFee - expectedExitFee;
    expect(close?.realizedGrossPnlUSDT).toBeCloseTo(expectedGross, 8);
    expect(close?.feesUSDT).toBeCloseTo(expectedEntryFee + expectedExitFee, 8);
    expect(close?.realizedNetPnlUSDT).toBeCloseTo(expectedNet, 8);
    expect(close?.position.entryFeeUSDT).toBeCloseTo(expectedEntryFee, 8);
    expect(close?.position.exitFeeUSDT).toBeCloseTo(expectedExitFee, 8);
  });

  it('computes deterministic SHORT close audit fields with maker-entry and taker-exit fees', () => {
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, direction: 'short', marginUSDT: 100, leverage: 1, tpRoiPct: 1, slRoiPct: 1, entryOffsetPct: 0, priceUpThrPct: 1, oiUpThrPct: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 99, openInterestValue: 990, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 989, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 98.01, openInterestValue: 988, ts: now });

    const close = positionUpdates.find((entry) => entry.status === 'CLOSED');
    expect(close).toBeTruthy();
    const entryPrice = close?.position.entryPrice ?? 0;
    const exitPrice = close?.exitPrice ?? 0;
    const qty = close?.position.qty ?? 0;
    const expectedEntryFee = entryPrice * qty * PAPER_FEES.makerFeeRate;
    const expectedExitFee = exitPrice * qty * PAPER_FEES.takerFeeRate;
    const expectedGross = (entryPrice - exitPrice) * qty;
    const expectedNet = expectedGross - expectedEntryFee - expectedExitFee;
    expect(close?.realizedGrossPnlUSDT).toBeCloseTo(expectedGross, 8);
    expect(close?.feesUSDT).toBeCloseTo(expectedEntryFee + expectedExitFee, 8);
    expect(close?.realizedNetPnlUSDT).toBeCloseTo(expectedNet, 8);
  });

  it('treats zero-net closes as neutral in stats buckets', () => {
    const engine = new BotEngine({
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, paperPartialFillPct: Number.NaN as unknown as number });
    const mutable = engine as unknown as {
      recordClosedTrade: (symbol: string, side: 'LONG' | 'SHORT', gross: number, fees: number, net: number, reason: string) => void;
    };
    mutable.recordClosedTrade('BTCUSDT', 'LONG', 0, 0, 0, 'OTHER');
    const stats = engine.getStats();
    expect(stats.totalTrades).toBe(1);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.long.wins).toBe(0);
    expect(stats.long.losses).toBe(0);
    expect(stats.perSymbol?.[0]?.wins ?? 0).toBe(0);
    expect(stats.perSymbol?.[0]?.losses ?? 0).toBe(0);
  });

  it('applies todayPnL guardrail using net pnl (including fees)', () => {
    const engine = new BotEngine({
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, dailyLossLimitUSDT: 0.05 });
    const mutable = engine as unknown as {
      recordClosedTrade: (symbol: string, side: 'LONG' | 'SHORT', gross: number, fees: number, net: number, reason: string) => void;
    };
    mutable.recordClosedTrade('BTCUSDT', 'LONG', 0, 0.06, -0.06, 'OTHER');
    expect(engine.getStats().todayPnlUSDT).toBeCloseTo(-0.06, 8);
    expect(engine.getStats().guardrailPauseReason).toBe('DAILY_LOSS_LIMIT');
  });

  it('fee accounting keeps net pnl = gross pnl - fees', () => {
    const positionUpdates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: (payload) => positionUpdates.push(payload),
      emitQueueUpdate: () => undefined
    });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, confirmMinContinuationPct: 0 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1021, ts: now });

    const position = engine.getSymbolState('BTCUSDT')?.position;
    expect(position).toBeTruthy();
    if (!position) return;
    engine.onMarketUpdate('BTCUSDT', { markPrice: position.tpPrice, openInterestValue: 1025, ts: now + 1 });

    const close = positionUpdates.find((entry) => entry.status === 'CLOSED');
    const closedPosition = close?.position;
    expect(closedPosition?.grossPnlUSDT).toBeDefined();
    expect(closedPosition?.feeTotalUSDT).toBeDefined();
    expect(closedPosition?.netPnlUSDT).toBeCloseTo((closedPosition?.grossPnlUSDT ?? 0) - (closedPosition?.feeTotalUSDT ?? 0));
  });
});

describe('BotEngine strategy hardening gates', () => {
  it('blocks long when higher-TF trend is down', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, trendLookbackBars: 1, trendMinMovePct: 0.2 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 110, openInterestValue: 1000, ts: now });
    now += 5 * 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 90, openInterestValue: 900, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 91.2, openInterestValue: 920, ts: now });

    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.fsmState).toBe('IDLE');
    expect(state?.lastNoEntryReasons[0]?.code).toBe('TREND_BLOCK_LONG');
  });

  it('resets with NO_CONTINUATION when follow-through never arrives', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, trendMinMovePct: 100, confirmWindowBars: 2, confirmMinContinuationPct: 0.5, impulseMaxAgeBars: 5 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.1, openInterestValue: 1021, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.05, openInterestValue: 1022, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.02, openInterestValue: 1023, ts: now });

    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.fsmState).toBe('IDLE');
    expect(state?.lastNoEntryReasons[0]?.code).toBe('NO_CONTINUATION');
  });

  it('resets with IMPULSE_STALE when impulse age exceeds max bars', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, trendMinMovePct: 100, confirmWindowBars: 5, confirmMinContinuationPct: 1, impulseMaxAgeBars: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.1, openInterestValue: 1021, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102.12, openInterestValue: 1022, ts: now });

    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.fsmState).toBe('IDLE');
    expect(state?.lastNoEntryReasons[0]?.code).toBe('IMPULSE_STALE');
  });

  it('fails OI two-candle gate when only one candle clears threshold', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, trendMinMovePct: 100, confirmMinContinuationPct: 0, requireOiTwoCandles: true, oiCandleThrPct: 1, oiUpThrPct: 1 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1025, ts: now });

    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.fsmState).toBe('IDLE');
    expect(state?.lastNoEntryReasons.some((entry) => entry.code === 'OI_2CANDLES_FAIL')).toBe(true);
  });
});


describe('BotEngine diagnostics + paper model hardening', () => {
  it('populates gate snapshot and preserves it via snapshot restore', () => {
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, confirmWindowBars: 2 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, bid: 99.9, ask: 100.1, spreadBps: 20, lastTickTs: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now, bid: 101.9, ask: 102.1, spreadBps: 19.6, lastTickTs: now - 250 });

    const state = engine.getSymbolState('BTCUSDT');
    expect(state?.gates).toBeTruthy();
    expect(state?.gates?.tf).toBe(1);
    expect(state?.gates?.higherTfMinutes).toBe(defaultConfig.trendTfMinutes);
    expect(state?.gates?.spreadBps).toBeCloseTo(19.6, 6);
    expect(state?.gates?.tickAgeMs).toBeGreaterThanOrEqual(0);

    const snapshotStore = { save: (snapshot: unknown) => (snapshotStore.saved = snapshot), load: () => null, clear: () => undefined, saved: null as unknown };
    const writer = new BotEngine({ emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined, snapshotStore });
    writer.setUniverseSymbols(['BTCUSDT']);
    writer.start(defaultConfig);
    (writer as unknown as { symbols: Map<string, unknown> }).symbols = (engine as unknown as { symbols: Map<string, unknown> }).symbols;
    (writer as unknown as { persistSnapshot: () => void }).persistSnapshot();

    const reader = new BotEngine({ emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    reader.restoreFromSnapshot((snapshotStore.saved as { symbols: Record<string, unknown> }) as never);
    expect(reader.getSymbolState('BTCUSDT')?.gates?.tf).toBe(1);
  });

  it('renders no-entry log with top reasons and value-threshold comparisons', () => {
    const logs: string[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({
      now: () => now,
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      emitLog: (line) => logs.push(line)
    });

    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, maxSpreadBps: 10, trendMinMovePct: 100 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, bid: 99, ask: 101, spreadBps: 200, lastTickTs: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now, bid: 100.8, ask: 103.2, spreadBps: 238.1, lastTickTs: now });

    const line = logs.find((entry) => entry.includes('No entry (BTCUSDT) (top reasons):'));
    expect(line).toBeTruthy();
    expect(line).toContain('1)');
    expect(line).toContain('SPREAD_TOO_WIDE');
    expect(line).toContain('max=10.00bps');
  });

  it('applies entry/exit slippage and partial fill to paper PnL', () => {
    const updates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: (payload) => updates.push(payload), emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1, entryOffsetPct: 0.1, paperEntrySlippageBps: 10, paperExitSlippageBps: 10, paperPartialFillPct: 50 });

    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now, bid: 99.9, ask: 100.1, spreadBps: 20, lastTickTs: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now, bid: 101.9, ask: 102.1, spreadBps: 19.6, lastTickTs: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 101.898, openInterestValue: 1021, ts: now, bid: 101.8, ask: 102, spreadBps: 19.6, lastTickTs: now });

    const opened = updates.find((entry) => entry.status === 'OPEN')?.position;
    expect(opened).toBeTruthy();
    expect(opened?.qty).toBeCloseTo((defaultConfig.marginUSDT * defaultConfig.leverage) / 101.898 * 0.5, 3);
    expect(opened?.entryLimit).toBeCloseTo(101.898, 6);
    expect(opened?.entryOffsetPct).toBeCloseTo(0.1, 6);
    expect(opened?.spreadBpsAtEntry).toBeCloseTo(19.6, 6);
    expect(opened?.entryPrice).toBeCloseTo(101.898 * 1.001, 6);

    const tp = opened!.tpPrice;
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: tp, openInterestValue: 1022, ts: now, bid: tp - 0.1, ask: tp + 0.1, spreadBps: 19.4, lastTickTs: now });
    const closed = updates.find((entry) => entry.status === 'CLOSED');
    expect(closed?.position.exitPrice).toBeCloseTo(tp * (1 - 0.001), 6);
    expect(typeof closed?.entry?.spreadBpsAtEntry).toBe('number');
    expect(typeof closed?.exit?.spreadBpsAtExit).toBe('number');
    expect(closed?.impact?.slippageUSDT).toBeCloseTo(closed?.position.slippageUSDT ?? 0, 8);
    expect(closed?.impact?.netPnlUSDT).toBeCloseTo((closed?.impact?.grossPnlUSDT ?? 0) - (closed?.impact?.feesUSDT ?? 0) - (closed?.impact?.slippageUSDT ?? 0), 8);
  });

  it('keeps default paper math unchanged when slippage=0 and partial=100', () => {
    const updates: PositionUpdatePayload[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: (payload) => updates.push(payload), emitQueueUpdate: () => undefined });
    engine.setUniverseSymbols(['BTCUSDT']);
    engine.start({ ...defaultConfig, signalCounterThreshold: 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 60_000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 102, openInterestValue: 1021, ts: now });
    const opened = updates.find((entry) => entry.status === 'OPEN')?.position;
    expect(opened?.entryPrice).toBeCloseTo(102, 8);
  });


  it('computes expectancy/profit factor and fee/net averages from closed trades', () => {
    const engine = new BotEngine({ now: () => Date.UTC(2025, 0, 1, 0, 0, 0), emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined });
    const mutable = engine as unknown as {
      recordClosedTrade: (symbol: string, side: 'LONG' | 'SHORT', gross: number, fees: number, net: number, reason: string, entryFeeUSDT?: number, exitFeeUSDT?: number, openedTs?: number, slippageUSDT?: number) => void;
    };

    mutable.recordClosedTrade('BTCUSDT', 'LONG', 1.2, 0.2, 1, 'TP', undefined, undefined, undefined, 0.05);
    mutable.recordClosedTrade('BTCUSDT', 'LONG', 1.2, 0.2, 1, 'TP', undefined, undefined, undefined, 0.05);
    mutable.recordClosedTrade('BTCUSDT', 'SHORT', -1.2, 0.2, -1, 'SL', undefined, undefined, undefined, 0.05);
    mutable.recordClosedTrade('BTCUSDT', 'SHORT', -1.2, 0.2, -1, 'SL', undefined, undefined, undefined, 0.05);

    const stats = engine.getStats();
    expect(stats.expectancyUSDT).toBeCloseTo(0, 8);
    expect(stats.profitFactor).toBeCloseTo(1, 8);
    expect(stats.avgFeePerTradeUSDT).toBeCloseTo(0.2, 8);
    expect(stats.avgNetPerTradeUSDT).toBeCloseTo(0, 8);
  });

  it('emits pnl sanity warning only when winrate is high and net is negative', () => {
    const logs: string[] = [];
    let now = Date.UTC(2025, 0, 1, 0, 0, 0);
    const engine = new BotEngine({ now: () => now, emitSignal: () => undefined, emitOrderUpdate: () => undefined, emitPositionUpdate: () => undefined, emitQueueUpdate: () => undefined, emitLog: (line) => logs.push(line) });
    const mutable = engine as unknown as { recordClosedTrade: (symbol: string, side: 'LONG' | 'SHORT', gross: number, fees: number, net: number, reason: string) => void };
    for (let i = 0; i < 12; i += 1) {
      mutable.recordClosedTrade('BTCUSDT', 'LONG', 0, 0, 0.2, 'TP');
      now += 1;
    }
    for (let i = 0; i < 8; i += 1) {
      mutable.recordClosedTrade('BTCUSDT', 'LONG', 0, 0, -0.5, 'SL');
      now += 1;
    }
    expect(logs.some((line) => line.includes('PNL_SANITY'))).toBe(true);
  });
});

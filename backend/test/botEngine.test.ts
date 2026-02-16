import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DemoCreateOrderParams, DemoOpenOrder, DemoPosition, IDemoTradeClient } from '../src/bybit/demoTradeClient.js';
import { BotEngine, type BotConfig, type OrderUpdatePayload, type PositionUpdatePayload, type SignalPayload } from '../src/bot/botEngine.js';
import { FileSnapshotStore } from '../src/bot/snapshotStore.js';

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

class FakeDemoTradeClient implements IDemoTradeClient {
  public readonly createCalls: DemoCreateOrderParams[] = [];
  public readonly cancelCalls: Array<{ symbol: string; orderId?: string; orderLinkId?: string }> = [];
  public openOrdersBySymbol = new Map<string, DemoOpenOrder[]>();
  public positionsBySymbol = new Map<string, DemoPosition | null>();
  public blockCreate = false;

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
    now += 1100;
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
    now += 1100;
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
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    now += 60 * 60 * 1000;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1100, ts: now });

    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('IDLE');
    expect(orderUpdates.map((u) => u.status)).toEqual(['PLACED', 'EXPIRED']);
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
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now + 1 });
    engine.onMarketUpdate('BTCUSDT', { markPrice: 104, openInterestValue: 1030, ts: now + 2 });

    now += 60_000;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 100, openInterestValue: 1000, ts: now });
    now += 10;
    engine.onMarketUpdate('ETHUSDT', { markPrice: 102, openInterestValue: 1020, ts: now });
    now += 1100;
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
    now += 1100;
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
    now += 1100;
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
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    engine.onMarketUpdate('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });

    const cancelled = await engine.cancelPendingOrder('ETHUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    expect(cancelled).toBe(true);
    expect(engine.getSymbolState('ETHUSDT')?.fsmState).toBe('IDLE');
    expect(engine.getSymbolState('ETHUSDT')?.overrideGateOnce).toBe(true);
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
    now += 1100;
    engine.onMarketUpdate('BTCUSDT', { markPrice: 103, openInterestValue: 1030, ts: now });
    await flush();

    now += 60 * 60 * 1000 + 1;
    await engine.pollDemoOrders({ BTCUSDT: { markPrice: 104, openInterestValue: 1050, ts: now } });

    expect(demoClient.cancelCalls).toHaveLength(1);
    expect(orderUpdates.map((entry) => entry.status)).toContain('EXPIRED');
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
    now += 1100;
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
    now += 1100;
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
    now += 1100;
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
      exitPrice: closeMarket.markPrice
    });
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
    now += 1100;
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
    now += 1100;
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

    if (snapshot) {
      reader.restoreFromSnapshot(snapshot);
    }
    expect(reader.getStats().totalTrades).toBe(1);
    expect(reader.getStats().wins).toBe(1);

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
    now += 1100;
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
    expect(engine.getSymbolState('BTCUSDT')?.fsmState).toBe('HOLDING_LONG');
  });
});

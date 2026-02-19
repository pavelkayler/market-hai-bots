import { describe, expect, it } from 'vitest';

import { BotEngine, getDefaultBotConfig } from './botEngine.js';
import { buildServer, getRuntimeHandles } from '../server.js';
import type { TickerStream, TickerUpdate } from '../market/tickerStream.js';


const marketState = (input: {
  markPrice: number;
  openInterestValue: number;
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  ts: number;
}) => ({
  ...input,
  lastPrice: input.markPrice,
  bid: null,
  ask: null,
  spreadBps: null,
  lastTickTs: input.ts
});

class FakeTickerStream implements TickerStream {
  private handler: ((update: TickerUpdate) => void) | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async setSymbols(): Promise<void> {}

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

describe('signal fsm regression', () => {
  const symbol = 'BTCUSDT';

  const createEngine = () => {
    let now = 0;
    const engine = new BotEngine({
      emitSignal: () => undefined,
      emitOrderUpdate: () => undefined,
      emitPositionUpdate: () => undefined,
      emitQueueUpdate: () => undefined,
      now: () => now
    });
    engine.setUniverseSymbols([symbol]);
    const config = getDefaultBotConfig();
    engine.start({
      ...config,
      mode: 'paper',
      direction: 'both',
      tf: 1,
      priceUpThrPct: 0.01,
      oiUpThrPct: 0.01,
      minFundingAbs: 0,
      signalCounterMin: 2,
      signalCounterMax: 3,
      confirmMinContinuationPct: 0,
      maxSecondsIntoCandle: 60,
      minNotionalUSDT: 1,
      marginUSDT: 10,
      leverage: 2,
      maxActiveSymbols: 5
    });

    return {
      engine,
      setNow: (value: number) => {
        now = value;
      }
    };
  };

  it('moves from wait confirmation to paper order for long funding side', () => {
    const { engine, setNow } = createEngine();

    setNow(1_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 100, openInterestValue: 1_000, fundingRate: 0.01, nextFundingTimeMs: 10_000_000, ts: 1_000 }));

    setNow(61_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 101, openInterestValue: 1_020, fundingRate: 0.01, nextFundingTimeMs: 10_000_000, ts: 61_000 }));
    const afterFirstSignal = engine.getSymbolState(symbol);
    expect(afterFirstSignal?.fsmState).toBe('HOLDING_LONG');

    setNow(121_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 102.5, openInterestValue: 1_050, fundingRate: 0.01, nextFundingTimeMs: 10_000_000, ts: 121_000 }));

    const afterSecondSignal = engine.getSymbolState(symbol);
    expect(afterSecondSignal?.fsmState).toBe('ENTRY_PENDING');
    expect(engine.getPaperExecution().getOpenOrders()).toHaveLength(1);
    expect(engine.getPaperExecution().getOpenOrders()[0]?.side).toBe('Buy');
  });

  it('uses SHORT side when funding is negative', () => {
    const { engine, setNow } = createEngine();

    setNow(1_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 100, openInterestValue: 1_000, fundingRate: -0.01, nextFundingTimeMs: 10_000_000, ts: 1_000 }));

    setNow(61_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 99, openInterestValue: 980, fundingRate: -0.01, nextFundingTimeMs: 10_000_000, ts: 61_000 }));

    setNow(121_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 98, openInterestValue: 960, fundingRate: -0.01, nextFundingTimeMs: 10_000_000, ts: 121_000 }));

    const symbolState = engine.getSymbolState(symbol);
    expect(symbolState?.fsmState).toBe('ENTRY_PENDING');
    expect(engine.getPaperExecution().getOpenOrders()[0]?.side).toBe('Sell');
  });

  it('stays waiting with FUNDING_MISSING block when funding is absent', () => {
    const { engine, setNow } = createEngine();

    setNow(1_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 100, openInterestValue: 1_000, fundingRate: null, nextFundingTimeMs: null, ts: 1_000 }));

    setNow(61_000);
    engine.onMarketUpdate(symbol, marketState({ markPrice: 101, openInterestValue: 1_020, fundingRate: null, nextFundingTimeMs: null, ts: 61_000 }));

    const symbolState = engine.getSymbolState(symbol);
    expect(symbolState?.fsmState).toBe('IDLE');
    expect(symbolState?.lastBlock?.reasonCode).toBe('FUNDING_MISSING');
  });

  it('exposes noEntryReason/noEntryDebug in /api/bot/state payload', async () => {
    const stream = new FakeTickerStream();
    let now = 1_000;
    const app = buildServer({ tickerStream: stream, now: () => now });
    await app.ready();

    const runtime = getRuntimeHandles(app).botEngine;
    runtime.setUniverseSymbols([symbol]);
    const cfg = getDefaultBotConfig();
    runtime.start({ ...cfg, mode: 'paper', tf: 1, priceUpThrPct: 10, oiUpThrPct: 10, minFundingAbs: 0, signalCounterMin: 2, signalCounterMax: 3 });

    stream.emit({ symbol, markPrice: 100, openInterestValue: 1_000, fundingRate: 0.01, nextFundingTimeMs: 10_000_000, ts: now });
    now = 61_000;
    stream.emit({ symbol, markPrice: 100.1, openInterestValue: 1_001, fundingRate: 0.01, nextFundingTimeMs: 10_000_000, ts: now });

    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    const row = payload.symbols.find((entry: { symbol: string }) => entry.symbol === symbol);
    expect(row?.noEntryReason).toBeTruthy();
    expect(row?.noEntryDebug).toBeTruthy();
    expect(row?.statusCode).toBe('WAIT_SIGNAL');

    await app.close();
  });
});


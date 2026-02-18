import { RealBybitWsTickerStream } from './realBybitWsTickerStream.js';
import type { TickerStream, TickerUpdate, TickerStreamStatus } from './tickerStream.js';

export type MarketState = {
  markPrice: number;
  openInterestValue: number;
  ts: number;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  spreadBps: number | null;
  lastTickTs: number;
};

type MarketHubOptions = {
  tickerStream?: TickerStream;
  onMarketStateUpdate?: (symbol: string, state: MarketState) => void;
};

export class MarketHub {
  private readonly states = new Map<string, MarketState>();
  private readonly subscribedSymbols = new Set<string>();
  private readonly updateTimestampsMs: number[] = [];
  private readonly stateUpdateListeners = new Set<(symbol: string, state: MarketState) => void>();
  private running = false;
  private readonly tickerStream: TickerStream;
  private unsubscribeTicker: (() => void) | null = null;
  private readonly onMarketStateUpdate?: (symbol: string, state: MarketState) => void;

  constructor(options: MarketHubOptions = {}) {
    this.tickerStream = options.tickerStream ?? new RealBybitWsTickerStream();
    this.onMarketStateUpdate = options.onMarketStateUpdate;
  }

  async start(): Promise<void> {
    if (!this.unsubscribeTicker) {
      this.unsubscribeTicker = this.tickerStream.onTicker((update) => this.handleTickerUpdate(update));
    }

    await this.tickerStream.start();
    this.running = true;
  }

  async stop(): Promise<void> {
    if (this.unsubscribeTicker) {
      this.unsubscribeTicker();
      this.unsubscribeTicker = null;
    }

    await this.tickerStream.stop();
    this.running = false;
  }

  async setUniverseSymbols(symbols: string[]): Promise<void> {
    const activeSymbols = new Set(symbols);
    this.subscribedSymbols.clear();
    for (const symbol of activeSymbols) {
      this.subscribedSymbols.add(symbol);
    }

    for (const symbol of this.states.keys()) {
      if (!activeSymbols.has(symbol)) {
        this.states.delete(symbol);
      }
    }

    await this.tickerStream.setSymbols(symbols);
  }


  isRunning(): boolean {
    return this.running;
  }

  getState(symbol: string): MarketState | undefined {
    return this.states.get(symbol);
  }

  getAllStates(): Record<string, MarketState> {
    return Object.fromEntries(this.states.entries());
  }

  getSubscribedCount(): number {
    return this.subscribedSymbols.size;
  }

  getTickerStreamStatus(): TickerStreamStatus {
    return this.tickerStream.getStatus?.() ?? {
      running: this.running,
      connected: this.running,
      desiredSymbolsCount: this.subscribedSymbols.size,
      subscribedCount: this.states.size,
      lastMessageAt: null,
      lastTickerAt: null,
      reconnectCount: 0,
      lastError: null
    };
  }

  getUpdatesPerSecond(windowMs = 5000): number {
    const nowMs = Date.now();
    this.pruneOldUpdates(nowMs, windowMs);
    return this.updateTimestampsMs.length / (windowMs / 1000);
  }

  onStateUpdate(handler: (symbol: string, state: MarketState) => void): () => void {
    this.stateUpdateListeners.add(handler);
    return () => {
      this.stateUpdateListeners.delete(handler);
    };
  }

  private handleTickerUpdate(update: TickerUpdate): void {
    this.updateTimestampsMs.push(Date.now());
    this.pruneOldUpdates(Date.now(), 5000);

    const nextState: MarketState = {
      markPrice: update.markPrice,
      openInterestValue: update.openInterestValue,
      ts: update.ts,
      lastPrice: update.lastPrice ?? null,
      bid: update.bid ?? null,
      ask: update.ask ?? null,
      spreadBps: update.spreadBps ?? null,
      lastTickTs: update.lastTickTs ?? update.ts
    };

    this.states.set(update.symbol, nextState);
    this.onMarketStateUpdate?.(update.symbol, nextState);
    for (const listener of this.stateUpdateListeners) {
      listener(update.symbol, nextState);
    }
  }

  private pruneOldUpdates(nowMs: number, windowMs: number): void {
    const minTs = nowMs - windowMs;
    while (this.updateTimestampsMs.length > 0 && this.updateTimestampsMs[0] < minTs) {
      this.updateTimestampsMs.shift();
    }
  }
}

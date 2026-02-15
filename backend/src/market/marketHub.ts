import { RealBybitWsTickerStream } from './realBybitWsTickerStream.js';
import type { TickerStream, TickerUpdate } from './tickerStream.js';

export type MarketState = {
  markPrice: number;
  openInterestValue: number;
  ts: number;
};

type MarketHubOptions = {
  tickerStream?: TickerStream;
  onMarketStateUpdate?: (symbol: string, state: MarketState) => void;
};

export class MarketHub {
  private readonly states = new Map<string, MarketState>();
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

  onStateUpdate(handler: (symbol: string, state: MarketState) => void): () => void {
    this.stateUpdateListeners.add(handler);
    return () => {
      this.stateUpdateListeners.delete(handler);
    };
  }

  private handleTickerUpdate(update: TickerUpdate): void {
    const nextState: MarketState = {
      markPrice: update.markPrice,
      openInterestValue: update.openInterestValue,
      ts: update.ts
    };

    this.states.set(update.symbol, nextState);
    this.onMarketStateUpdate?.(update.symbol, nextState);
    for (const listener of this.stateUpdateListeners) {
      listener(update.symbol, nextState);
    }
  }
}

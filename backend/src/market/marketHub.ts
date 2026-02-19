import type { FundingSnapshotEntry } from './fundingSnapshotService.js';
import { RealBybitWsTickerStream } from './realBybitWsTickerStream.js';
import type { TickerStream, TickerUpdate, TickerStreamStatus } from './tickerStream.js';
import type { IBybitMarketClient } from '../services/bybitMarketClient.js';

export type MarketState = {
  markPrice: number;
  openInterestValue: number;
  fundingRate?: number | null;
  nextFundingTimeMs?: number | null;
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
  marketClient?: Pick<IBybitMarketClient, 'getTickerLinear'>;
  getFundingSnapshot?: (symbol: string) => FundingSnapshotEntry | null;
  now?: () => number;
};

const OIV_REFRESH_INTERVAL_MS = 5_000;
const OIV_REFRESH_CONCURRENCY = 5;

const normalizeFinite = (value: number | null | undefined): number | null => (Number.isFinite(value ?? Number.NaN) ? Number(value) : null);

export class MarketHub {
  private readonly states = new Map<string, MarketState>();
  private readonly subscribedSymbols = new Set<string>();
  private readonly updateTimestampsMs: number[] = [];
  private readonly stateUpdateListeners = new Set<(symbol: string, state: MarketState) => void>();
  private running = false;
  private readonly tickerStream: TickerStream;
  private unsubscribeTicker: (() => void) | null = null;
  private readonly onMarketStateUpdate?: (symbol: string, state: MarketState) => void;
  private readonly marketClient?: Pick<IBybitMarketClient, 'getTickerLinear'>;
  private readonly getFundingSnapshot?: (symbol: string) => FundingSnapshotEntry | null;
  private readonly now: () => number;
  private oivRefreshTimer: NodeJS.Timeout | null = null;
  private oivRefreshInFlight = false;

  constructor(options: MarketHubOptions = {}) {
    this.tickerStream = options.tickerStream ?? new RealBybitWsTickerStream();
    this.onMarketStateUpdate = options.onMarketStateUpdate;
    this.marketClient = options.marketClient;
    this.getFundingSnapshot = options.getFundingSnapshot;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (!this.unsubscribeTicker) {
      this.unsubscribeTicker = this.tickerStream.onTicker((update) => this.handleTickerUpdate(update));
    }

    await this.tickerStream.start();
    this.running = true;
    this.startOivRefreshLoop();
  }

  async stop(): Promise<void> {
    if (this.unsubscribeTicker) {
      this.unsubscribeTicker();
      this.unsubscribeTicker = null;
    }

    this.stopOivRefreshLoop();
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

  getSubscribedSymbols(): string[] {
    return Array.from(this.subscribedSymbols);
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
    const nowMs = this.now();
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
    const nowMs = this.now();
    this.updateTimestampsMs.push(nowMs);
    this.pruneOldUpdates(nowMs, 5000);

    const previousState = this.states.get(update.symbol);
    const fundingSnapshot = this.getFundingSnapshot?.(update.symbol) ?? null;

    const openInterestValue = normalizeFinite(update.openInterestValue) ?? previousState?.openInterestValue ?? 0;
    const fundingRate = normalizeFinite(update.fundingRate) ?? previousState?.fundingRate ?? fundingSnapshot?.fundingRate ?? null;
    const nextFundingTimeMs = normalizeFinite(update.nextFundingTimeMs) ?? previousState?.nextFundingTimeMs ?? fundingSnapshot?.nextFundingTimeMs ?? null;

    const nextState: MarketState = {
      markPrice: update.markPrice,
      openInterestValue,
      fundingRate,
      nextFundingTimeMs,
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

  private startOivRefreshLoop(): void {
    if (!this.marketClient || this.oivRefreshTimer) {
      return;
    }

    this.oivRefreshTimer = setInterval(() => {
      void this.refreshMissingMarketFields();
    }, OIV_REFRESH_INTERVAL_MS);
  }

  private stopOivRefreshLoop(): void {
    if (!this.oivRefreshTimer) {
      return;
    }

    clearInterval(this.oivRefreshTimer);
    this.oivRefreshTimer = null;
  }

  private async refreshMissingMarketFields(): Promise<void> {
    if (!this.marketClient || this.oivRefreshInFlight || this.subscribedSymbols.size === 0) {
      return;
    }

    const symbolsToRefresh = Array.from(this.subscribedSymbols).filter((symbol) => {
      const state = this.states.get(symbol);
      if (!state) {
        return true;
      }
      const missingOiv = !Number.isFinite(state.openInterestValue) || state.openInterestValue <= 0;
      const missingFunding = !Number.isFinite(state.fundingRate ?? Number.NaN) || !Number.isFinite(state.nextFundingTimeMs ?? Number.NaN);
      return missingOiv || missingFunding;
    });

    if (symbolsToRefresh.length === 0) {
      return;
    }

    this.oivRefreshInFlight = true;
    try {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(OIV_REFRESH_CONCURRENCY, symbolsToRefresh.length) }, async () => {
        while (cursor < symbolsToRefresh.length) {
          const symbol = symbolsToRefresh[cursor];
          cursor += 1;
          const ticker = await this.marketClient!.getTickerLinear(symbol).catch(() => null);
          if (!ticker) {
            continue;
          }

          const previousState = this.states.get(symbol);
          const fundingSnapshot = this.getFundingSnapshot?.(symbol) ?? null;
          const nextState: MarketState = {
            markPrice: normalizeFinite(previousState?.markPrice) ?? normalizeFinite(ticker.markPrice) ?? 0,
            openInterestValue:
              normalizeFinite(previousState?.openInterestValue) && (previousState?.openInterestValue ?? 0) > 0
                ? previousState!.openInterestValue
                : normalizeFinite(ticker.openInterestValue) ?? 0,
            fundingRate:
              normalizeFinite(previousState?.fundingRate) ?? normalizeFinite(ticker.fundingRate) ?? fundingSnapshot?.fundingRate ?? null,
            nextFundingTimeMs:
              normalizeFinite(previousState?.nextFundingTimeMs) ?? normalizeFinite(ticker.nextFundingTime ?? null) ?? fundingSnapshot?.nextFundingTimeMs ?? null,
            ts: previousState?.ts ?? this.now(),
            lastPrice: previousState?.lastPrice ?? null,
            bid: previousState?.bid ?? null,
            ask: previousState?.ask ?? null,
            spreadBps: previousState?.spreadBps ?? null,
            lastTickTs: previousState?.lastTickTs ?? this.now()
          };

          if (nextState.openInterestValue <= 0 && normalizeFinite(previousState?.openInterestValue) && (previousState?.openInterestValue ?? 0) > 0) {
            nextState.openInterestValue = previousState!.openInterestValue;
          }

          if (!previousState) {
            this.states.set(symbol, nextState);
            continue;
          }

          const shouldPatchOiv = (!Number.isFinite(previousState.openInterestValue) || previousState.openInterestValue <= 0) && nextState.openInterestValue > 0;
          const shouldPatchFunding =
            (!Number.isFinite(previousState.fundingRate ?? Number.NaN) || !Number.isFinite(previousState.nextFundingTimeMs ?? Number.NaN)) &&
            Number.isFinite(nextState.fundingRate ?? Number.NaN) &&
            Number.isFinite(nextState.nextFundingTimeMs ?? Number.NaN);

          if (!shouldPatchOiv && !shouldPatchFunding) {
            continue;
          }

          const patchedState: MarketState = {
            ...previousState,
            ...(shouldPatchOiv ? { openInterestValue: nextState.openInterestValue } : {}),
            ...(shouldPatchFunding
              ? {
                  fundingRate: nextState.fundingRate,
                  nextFundingTimeMs: nextState.nextFundingTimeMs
                }
              : {})
          };
          this.states.set(symbol, patchedState);
        }
      });
      await Promise.all(workers);
    } finally {
      this.oivRefreshInFlight = false;
    }
  }

  private pruneOldUpdates(nowMs: number, windowMs: number): void {
    const minTs = nowMs - windowMs;
    while (this.updateTimestampsMs.length > 0 && this.updateTimestampsMs[0] < minTs) {
      this.updateTimestampsMs.shift();
    }
  }
}

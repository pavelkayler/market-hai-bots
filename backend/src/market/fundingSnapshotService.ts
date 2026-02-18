import type { FastifyBaseLogger } from 'fastify';

import type { IBybitMarketClient } from '../services/bybitMarketClient.js';

export type FundingSnapshotSource = 'REST_TICKERS';

export type FundingSnapshotEntry = {
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  fetchedAtMs: number;
  source: FundingSnapshotSource;
};

export type FundingSnapshotStatus = {
  lastRefreshAtMs: number | null;
  lastError?: string;
  refreshCount: number;
  nextScheduledAtMs: number | null;
};

type UniverseProvider = {
  getSymbols: () => string[];
};

type FundingSnapshotInitOptions = {
  bybitClient: Pick<IBybitMarketClient, 'getTickersLinear'>;
  universeProvider: UniverseProvider;
  logger: FastifyBaseLogger;
};

const REFRESH_INTERVAL_MS = 600_000;
const UNIVERSE_REFRESH_DEBOUNCE_MS = 2_000;

const parseFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const normalizeEpochToMs = (value: unknown): number | null => {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) {
    return null;
  }

  if (parsed <= 0) {
    return null;
  }

  return parsed < 1_000_000_000_000 ? Math.floor(parsed * 1000) : Math.floor(parsed);
};

export class FundingSnapshotService {
  private readonly cache = new Map<string, FundingSnapshotEntry>();
  private bybitClient: Pick<IBybitMarketClient, 'getTickersLinear'> | null = null;
  private universeProvider: UniverseProvider | null = null;
  private logger: FastifyBaseLogger | null = null;
  private running = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  private debouncedUniverseRefresh: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private lastRefreshAtMs: number | null = null;
  private lastError: string | undefined;
  private refreshCount = 0;
  private nextScheduledAtMs: number | null = null;

  init(options: FundingSnapshotInitOptions): void {
    this.bybitClient = options.bybitClient;
    this.universeProvider = options.universeProvider;
    this.logger = options.logger;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.nextScheduledAtMs = Date.now() + REFRESH_INTERVAL_MS;
    this.intervalHandle = setInterval(() => {
      void this.refreshNowBestEffort('interval_10m');
      this.nextScheduledAtMs = Date.now() + REFRESH_INTERVAL_MS;
    }, REFRESH_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.debouncedUniverseRefresh) {
      clearTimeout(this.debouncedUniverseRefresh);
      this.debouncedUniverseRefresh = null;
    }
    this.nextScheduledAtMs = null;
  }

  scheduleUniverseRefresh(): void {
    if (!this.running) {
      return;
    }
    if (this.debouncedUniverseRefresh) {
      clearTimeout(this.debouncedUniverseRefresh);
    }

    this.debouncedUniverseRefresh = setTimeout(() => {
      this.debouncedUniverseRefresh = null;
      void this.refreshNowBestEffort('universe_change');
    }, UNIVERSE_REFRESH_DEBOUNCE_MS);
  }

  async refreshNowBestEffort(reason: string): Promise<void> {
    if (!this.bybitClient || !this.universeProvider || !this.logger) {
      return;
    }

    const symbols = Array.from(new Set(this.universeProvider.getSymbols().map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)));
    if (symbols.length === 0) {
      return;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const logger = this.logger;
    this.refreshInFlight = (async () => {
      try {
        const tickersBySymbol = await this.bybitClient!.getTickersLinear();
        const nowMs = Date.now();
        let updated = 0;

        for (const symbol of symbols) {
          const ticker = tickersBySymbol.get(symbol) as (Record<string, unknown> & { fundingRate?: unknown; nextFundingTime?: unknown }) | undefined;
          if (!ticker) {
            continue;
          }

          const fundingRate = parseFiniteNumber(ticker.fundingRate);
          const nextFundingTimeMs = normalizeEpochToMs(ticker.nextFundingTime);

          this.cache.set(symbol, {
            fundingRate,
            nextFundingTimeMs,
            fetchedAtMs: nowMs,
            source: 'REST_TICKERS'
          });
          updated += 1;
        }

        this.lastRefreshAtMs = nowMs;
        this.lastError = undefined;
        this.refreshCount += 1;
        logger?.info({ reason, symbolsRequested: symbols.length, symbolsUpdated: updated }, 'funding snapshot refresh completed');
      } catch (error) {
        const message = (error as Error).message ?? 'unknown funding refresh error';
        this.lastError = message;
        logger?.warn({ reason, error: message }, 'funding snapshot refresh failed (best-effort)');
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  get(symbol: string): FundingSnapshotEntry | null {
    return this.cache.get(symbol) ?? null;
  }

  getMany(symbols: string[]): Record<string, FundingSnapshotEntry | null> {
    const result: Record<string, FundingSnapshotEntry | null> = {};
    for (const symbol of symbols) {
      result[symbol] = this.cache.get(symbol) ?? null;
    }
    return result;
  }

  getStatus(): FundingSnapshotStatus {
    return {
      lastRefreshAtMs: this.lastRefreshAtMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      refreshCount: this.refreshCount,
      nextScheduledAtMs: this.nextScheduledAtMs
    };
  }
}

export const FUNDING_MAX_AGE_MS = 660_000;

export const classifyFundingSnapshot = (
  entry: FundingSnapshotEntry | null,
  nowMs: number
): {
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  fundingAgeMs: number | null;
  fundingStatus: 'OK' | 'MISSING' | 'STALE';
  fundingFetchedAtMs: number | null;
} => {
  if (!entry) {
    return { fundingRate: null, nextFundingTimeMs: null, fundingAgeMs: null, fundingStatus: 'MISSING', fundingFetchedAtMs: null };
  }

  const ageMs = Math.max(0, nowMs - entry.fetchedAtMs);
  if (ageMs > FUNDING_MAX_AGE_MS) {
    return {
      fundingRate: null,
      nextFundingTimeMs: null,
      fundingAgeMs: ageMs,
      fundingStatus: 'STALE',
      fundingFetchedAtMs: entry.fetchedAtMs
    };
  }

  if (!Number.isFinite(entry.fundingRate ?? Number.NaN)) {
    return {
      fundingRate: null,
      nextFundingTimeMs: entry.nextFundingTimeMs,
      fundingAgeMs: ageMs,
      fundingStatus: 'MISSING',
      fundingFetchedAtMs: entry.fetchedAtMs
    };
  }

  return {
    fundingRate: entry.fundingRate,
    nextFundingTimeMs: entry.nextFundingTimeMs,
    fundingAgeMs: ageMs,
    fundingStatus: 'OK',
    fundingFetchedAtMs: entry.fetchedAtMs
  };
};

import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import type { IBybitMarketClient, TickerLinear } from './bybitMarketClient.js';
import type { UniverseEntry, UniverseFilters, UniverseState } from '../types/universe.js';

const MIN_TURNOVER = 10000000 as const;

export class ActiveSymbolSet {
  private readonly active = new Set<string>();

  get(): Set<string> {
    return new Set(this.active);
  }

  replace(symbols: string[]): void {
    this.active.clear();
    for (const symbol of symbols) {
      this.active.add(symbol);
    }
  }

  add(symbol: string): void {
    this.active.add(symbol);
  }

  remove(symbol: string): void {
    this.active.delete(symbol);
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const computeVol24hPct = (highPrice24h: number, lowPrice24h: number): number | null => {
  if (lowPrice24h <= 0) {
    return null;
  }

  return ((highPrice24h - lowPrice24h) / lowPrice24h) * 100;
};

export class UniverseService {
  private state: UniverseState | null = null;

  constructor(
    private readonly marketClient: IBybitMarketClient,
    private readonly activeSymbolSet: ActiveSymbolSet,
    private readonly logger: FastifyBaseLogger,
    // backend-local path to make `cd backend && npm run dev` read/write from backend/data/universe.json.
    private readonly universeFilePath = path.resolve(process.cwd(), 'data/universe.json')
  ) {}

  async create(minVolPct: number): Promise<{ state: UniverseState; totalFetched: number; forcedActive: number }> {
    const built = await this.buildFilteredUniverse(minVolPct);

    const nextState: UniverseState = {
      createdAt: Date.now(),
      filters: { minTurnover: MIN_TURNOVER, minVolPct },
      symbols: built.entries,
      ready: true
    };

    this.state = nextState;
    await this.persist(nextState);

    return { state: nextState, totalFetched: built.totalFetched, forcedActive: 0 };
  }

  async refresh(minVolPct?: number): Promise<{ state: UniverseState; forcedActive: number } | null> {
    const active = this.state ?? (await this.loadFromDisk());
    const effectiveMinVolPct = minVolPct ?? active?.filters.minVolPct;

    if (effectiveMinVolPct === undefined) {
      return null;
    }

    const built = await this.buildFilteredUniverse(effectiveMinVolPct);
    const forced = this.mergeForcedActive(built.entries, built.tickersBySymbol);

    const nextState: UniverseState = {
      createdAt: Date.now(),
      filters: { minTurnover: MIN_TURNOVER, minVolPct: effectiveMinVolPct },
      symbols: forced.entries,
      ready: true
    };

    this.state = nextState;
    await this.persist(nextState);

    return { state: nextState, forcedActive: forced.forcedCount };
  }

  async get(): Promise<UniverseState | null> {
    if (this.state) {
      return this.state;
    }

    this.state = await this.loadFromDisk();
    return this.state;
  }

  async clear(): Promise<void> {
    this.state = null;
    try {
      await rm(this.universeFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async buildFilteredUniverse(minVolPct: number): Promise<{
    entries: UniverseEntry[];
    totalFetched: number;
    tickersBySymbol: Map<string, TickerLinear>;
  }> {
    const [instruments, tickersBySymbol] = await Promise.all([
      this.marketClient.getInstrumentsLinearAll(),
      this.marketClient.getTickersLinear()
    ]);

    const entries: UniverseEntry[] = [];

    for (const instrument of instruments) {
      const ticker = tickersBySymbol.get(instrument.symbol);
      if (!ticker) {
        continue;
      }

      const turnover24h = ticker.turnover24h;
      const highPrice24h = ticker.highPrice24h;
      const lowPrice24h = ticker.lowPrice24h;
      if (!isFiniteNumber(turnover24h) || !isFiniteNumber(highPrice24h) || !isFiniteNumber(lowPrice24h)) {
        continue;
      }

      const vol24hPct = computeVol24hPct(highPrice24h, lowPrice24h);
      if (!isFiniteNumber(vol24hPct)) {
        continue;
      }

      if (turnover24h >= MIN_TURNOVER && vol24hPct >= minVolPct) {
        entries.push({
          symbol: instrument.symbol,
          turnover24h,
          highPrice24h,
          lowPrice24h,
          vol24hPct,
          forcedActive: false
        });
      }
    }

    return { entries, totalFetched: instruments.length, tickersBySymbol };
  }

  private mergeForcedActive(filtered: UniverseEntry[], tickersBySymbol: Map<string, TickerLinear>): {
    entries: UniverseEntry[];
    forcedCount: number;
  } {
    const symbols = new Map<string, UniverseEntry>();
    for (const entry of filtered) {
      symbols.set(entry.symbol, entry);
    }

    let forcedCount = 0;

    for (const activeSymbol of this.activeSymbolSet.get()) {
      if (symbols.has(activeSymbol)) {
        continue;
      }

      const ticker = tickersBySymbol.get(activeSymbol);
      if (!ticker) {
        this.logger.warn({ symbol: activeSymbol }, 'Active symbol missing from tickers during universe refresh');
        symbols.set(activeSymbol, {
          symbol: activeSymbol,
          turnover24h: 0,
          highPrice24h: 0,
          lowPrice24h: 0,
          vol24hPct: 0,
          forcedActive: true
        });
        forcedCount += 1;
        continue;
      }

      const turnover24h = ticker.turnover24h ?? 0;
      const highPrice24h = ticker.highPrice24h ?? 0;
      const lowPrice24h = ticker.lowPrice24h ?? 0;
      const vol24hPct =
        isFiniteNumber(highPrice24h) && isFiniteNumber(lowPrice24h)
          ? computeVol24hPct(highPrice24h, lowPrice24h) ?? 0
          : 0;

      symbols.set(activeSymbol, {
        symbol: activeSymbol,
        turnover24h,
        highPrice24h,
        lowPrice24h,
        vol24hPct,
        forcedActive: true
      });
      forcedCount += 1;
    }

    return { entries: Array.from(symbols.values()), forcedCount };
  }

  private async persist(state: UniverseState): Promise<void> {
    await mkdir(path.dirname(this.universeFilePath), { recursive: true });
    await writeFile(this.universeFilePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  private async loadFromDisk(): Promise<UniverseState | null> {
    try {
      await access(this.universeFilePath);
    } catch {
      return null;
    }

    const content = await readFile(this.universeFilePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<UniverseState>;

    if (
      !parsed ||
      !isFiniteNumber(parsed.createdAt) ||
      typeof parsed.ready !== 'boolean' ||
      !parsed.filters ||
      !isFiniteNumber(parsed.filters.minVolPct) ||
      !Array.isArray(parsed.symbols)
    ) {
      return null;
    }

    const symbols = parsed.symbols.filter((entry): entry is UniverseEntry => {
      return (
        !!entry &&
        typeof entry.symbol === 'string' &&
        isFiniteNumber(entry.turnover24h) &&
        isFiniteNumber(entry.highPrice24h) &&
        isFiniteNumber(entry.lowPrice24h) &&
        isFiniteNumber(entry.vol24hPct) &&
        typeof entry.forcedActive === 'boolean'
      );
    });

    const filters: UniverseFilters = {
      minTurnover: MIN_TURNOVER,
      minVolPct: parsed.filters.minVolPct
    };

    return {
      createdAt: parsed.createdAt,
      ready: parsed.ready,
      filters,
      symbols
    };
  }
}

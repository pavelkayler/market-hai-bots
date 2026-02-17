import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from './bybitMarketClient.js';
import { isUsdtLinearPerpetualInstrument, UNIVERSE_CONTRACT_FILTER } from './universeContractFilter.js';
import type { UniverseEntry, UniverseFilters, UniverseState } from '../types/universe.js';

const MIN_TURNOVER = 10000000 as const;
const INSTRUMENTS_CACHE_TTL_MS = 30_000 as const;

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

const VOLATILITY_DEFINITION = 'vol24hRangePct = (high24h-low24h)/low24h*100 (guard: low24h > 0); this is a 24h range metric, not intra-candle volatility.' as const;
const TURNOVER_DEFINITION = 'turnover24hUSDT = 24h turnover in USDT from Bybit ticker (turnover24h or turnover24hValue).' as const;
const METRIC_DEFINITION = `${TURNOVER_DEFINITION} ${VOLATILITY_DEFINITION}` as const;

const computeVol24hRangePct = (highPrice24h: number, lowPrice24h: number): number | null => {
  if (lowPrice24h <= 0) {
    return null;
  }

  return ((highPrice24h - lowPrice24h) / lowPrice24h) * 100;
};

export class UniverseService {
  private state: UniverseState | null = null;
  private instrumentsCache: { expiresAt: number; bySymbol: Map<string, InstrumentLinear> } | null = null;

  constructor(
    private readonly marketClient: IBybitMarketClient,
    private readonly activeSymbolSet: ActiveSymbolSet,
    private readonly logger: FastifyBaseLogger,
    // backend-local path to make `cd backend && npm run dev` read/write from backend/data/universe.json.
    private readonly universeFilePath = path.resolve(process.cwd(), 'data/universe.json')
  ) {}

  async create(minVolPct: number, minTurnover: number = MIN_TURNOVER): Promise<{ state: UniverseState; totalFetched: number; forcedActive: number }> {
    const built = await this.buildFilteredUniverse(minVolPct, minTurnover);

    const nextState: UniverseState = {
      createdAt: Date.now(),
      filters: { minTurnover, minVolPct },
      metricDefinition: METRIC_DEFINITION,
      symbols: built.entries,
      ready: true,
      totalSymbols: built.totalFetched,
      validSymbols: built.validCount,
      filteredOut: {
        expiringOrNonPerp: built.totalFetched - built.validCount,
        byMetricThreshold: built.metricFilteredCount,
        dataUnavailable: built.dataUnavailableCount
      },
      contractFilter: UNIVERSE_CONTRACT_FILTER
    };

    this.state = this.normalizeBuiltState(nextState);
    await this.persist(this.state);

    return { state: this.state, totalFetched: built.totalFetched, forcedActive: 0 };
  }

  async refresh(minVolPct?: number, minTurnover?: number): Promise<{ state: UniverseState; forcedActive: number } | null> {
    const active = this.state ?? (await this.loadFromDisk());
    const effectiveMinVolPct = minVolPct ?? active?.filters.minVolPct;
    const effectiveMinTurnover = minTurnover ?? active?.filters.minTurnover;

    if (effectiveMinVolPct === undefined || effectiveMinTurnover === undefined) {
      return null;
    }

    const built = await this.buildFilteredUniverse(effectiveMinVolPct, effectiveMinTurnover);
    const forced = this.mergeForcedActive(built.entries, built.tickersBySymbol, built.instrumentBySymbol);

    const nextState: UniverseState = {
      createdAt: Date.now(),
      filters: { minTurnover: effectiveMinTurnover, minVolPct: effectiveMinVolPct },
      metricDefinition: METRIC_DEFINITION,
      symbols: forced.entries,
      ready: true,
      totalSymbols: built.totalFetched,
      validSymbols: built.validCount,
      filteredOut: {
        expiringOrNonPerp: built.totalFetched - built.validCount,
        byMetricThreshold: built.metricFilteredCount,
        dataUnavailable: built.dataUnavailableCount
      },
      contractFilter: UNIVERSE_CONTRACT_FILTER
    };

    this.state = this.normalizeBuiltState(nextState);
    await this.persist(this.state);

    return { state: this.state, forcedActive: forced.forcedCount };
  }

  async get(): Promise<UniverseState | null> {
    if (!this.state) {
      this.state = await this.loadFromDisk();
      if (!this.state) {
        return null;
      }
    }

    if (
      this.state.contractFilter === UNIVERSE_CONTRACT_FILTER &&
      isFiniteNumber(this.state.totalSymbols) &&
      isFiniteNumber(this.state.validSymbols) &&
      this.state.filteredOut !== undefined
    ) {
      return this.state;
    }

    const sanitized = await this.sanitizePersistedUniverseState(this.state);
    if (JSON.stringify(sanitized) !== JSON.stringify(this.state)) {
      this.state = sanitized;
      await this.persist(this.state);
    }

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

  private async buildFilteredUniverse(minVolPct: number, minTurnover: number): Promise<{
    entries: UniverseEntry[];
    totalFetched: number;
    validCount: number;
    metricFilteredCount: number;
    dataUnavailableCount: number;
    tickersBySymbol: Map<string, TickerLinear>;
    instrumentBySymbol: Map<string, InstrumentLinear>;
  }> {
    const [instruments, tickersBySymbol] = await Promise.all([this.marketClient.getInstrumentsLinearAll(), this.marketClient.getTickersLinear()]);

    const instrumentBySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    const entries: UniverseEntry[] = [];
    const validInstruments = instruments.filter((instrument) => isUsdtLinearPerpetualInstrument(instrument));
    let metricFilteredCount = 0;
    let dataUnavailableCount = 0;

    for (const instrument of validInstruments) {
      const ticker = tickersBySymbol.get(instrument.symbol);
      if (!ticker) {
        dataUnavailableCount += 1;
        continue;
      }

      const turnover24hUSDT = ticker.turnover24hUSDT ?? ticker.turnover24h;
      const highPrice24h = ticker.highPrice24h;
      const lowPrice24h = ticker.lowPrice24h;
      if (!isFiniteNumber(turnover24hUSDT) || !isFiniteNumber(highPrice24h) || !isFiniteNumber(lowPrice24h)) {
        dataUnavailableCount += 1;
        continue;
      }

      const vol24hRangePct = computeVol24hRangePct(highPrice24h, lowPrice24h);
      if (!isFiniteNumber(vol24hRangePct)) {
        dataUnavailableCount += 1;
        continue;
      }

      if (turnover24hUSDT >= minTurnover && vol24hRangePct >= minVolPct) {
        entries.push({
          symbol: instrument.symbol,
          turnover24hUSDT,
          turnover24h: turnover24hUSDT,
          highPrice24h,
          lowPrice24h,
          vol24hRangePct,
          vol24hPct: vol24hRangePct,
          forcedActive: false,
          qtyStep: instrument.qtyStep,
          minOrderQty: instrument.minOrderQty,
          maxOrderQty: instrument.maxOrderQty
        });
      } else {
        metricFilteredCount += 1;
      }
    }

    return {
      entries,
      totalFetched: instruments.length,
      validCount: validInstruments.length,
      metricFilteredCount,
      dataUnavailableCount,
      tickersBySymbol,
      instrumentBySymbol
    };
  }

  private mergeForcedActive(
    filtered: UniverseEntry[],
    tickersBySymbol: Map<string, TickerLinear>,
    instrumentBySymbol: Map<string, InstrumentLinear>
  ): {
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
      const instrument = instrumentBySymbol.get(activeSymbol);
      if (!instrument || !isUsdtLinearPerpetualInstrument(instrument)) {
        this.logger.warn({ symbol: activeSymbol }, 'Skipping forced active symbol that does not match universe contract filter');
        continue;
      }

      if (!ticker) {
        this.logger.warn({ symbol: activeSymbol }, 'Active symbol missing from tickers during universe refresh');
        symbols.set(activeSymbol, {
          symbol: activeSymbol,
          turnover24hUSDT: 0,
          turnover24h: 0,
          highPrice24h: 0,
          lowPrice24h: 0,
          vol24hRangePct: 0,
          vol24hPct: 0,
          forcedActive: true,
          qtyStep: null,
          minOrderQty: null,
          maxOrderQty: null
        });
        forcedCount += 1;
        continue;
      }

      const turnover24hUSDT = ticker.turnover24hUSDT ?? ticker.turnover24h ?? 0;
      const highPrice24h = ticker.highPrice24h ?? 0;
      const lowPrice24h = ticker.lowPrice24h ?? 0;
      const vol24hRangePct =
        isFiniteNumber(highPrice24h) && isFiniteNumber(lowPrice24h)
          ? computeVol24hRangePct(highPrice24h, lowPrice24h) ?? 0
          : 0;

      symbols.set(activeSymbol, {
        symbol: activeSymbol,
        turnover24hUSDT,
        turnover24h: turnover24hUSDT,
        highPrice24h,
        lowPrice24h,
        vol24hRangePct,
        vol24hPct: vol24hRangePct,
        forcedActive: true,
        qtyStep: instrument?.qtyStep ?? null,
        minOrderQty: instrument?.minOrderQty ?? null,
        maxOrderQty: instrument?.maxOrderQty ?? null
      });
      forcedCount += 1;
    }

    return { entries: Array.from(symbols.values()), forcedCount };
  }

  private async getInstrumentBySymbolCached(): Promise<Map<string, InstrumentLinear>> {
    const now = Date.now();
    if (this.instrumentsCache && this.instrumentsCache.expiresAt > now) {
      return this.instrumentsCache.bySymbol;
    }

    const instruments = await this.marketClient.getInstrumentsLinearAll();
    const bySymbol = new Map(instruments.map((instrument) => [instrument.symbol, instrument]));
    this.instrumentsCache = {
      bySymbol,
      expiresAt: now + INSTRUMENTS_CACHE_TTL_MS
    };
    return bySymbol;
  }

  private async sanitizePersistedUniverseState(state: UniverseState): Promise<UniverseState> {
    const instrumentsBySymbol = await this.getInstrumentBySymbolCached();
    const totalSymbols = state.symbols.length;
    const validEntries = state.symbols.filter((entry) => {
      const instrument = instrumentsBySymbol.get(entry.symbol);
      return !!instrument && isUsdtLinearPerpetualInstrument(instrument);
    });

    return this.normalizeBuiltState({
      ...state,
      symbols: validEntries,
      totalSymbols,
      validSymbols: validEntries.length,
      filteredOut: {
        expiringOrNonPerp: Math.max(0, totalSymbols - validEntries.length),
        byMetricThreshold: state.filteredOut?.byMetricThreshold,
        dataUnavailable: state.filteredOut?.dataUnavailable
      },
      contractFilter: UNIVERSE_CONTRACT_FILTER
    });
  }

  private normalizeBuiltState(state: UniverseState): UniverseState {
    return {
      ...state,
      ready: true,
      notReadyReason: undefined
    };
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
        isFiniteNumber(entry.turnover24hUSDT ?? entry.turnover24h) &&
        isFiniteNumber(entry.highPrice24h) &&
        isFiniteNumber(entry.lowPrice24h) &&
        isFiniteNumber(entry.vol24hRangePct ?? entry.vol24hPct) &&
        typeof entry.forcedActive === 'boolean' &&
        (entry.qtyStep === null || entry.qtyStep === undefined || isFiniteNumber(entry.qtyStep)) &&
        (entry.minOrderQty === null || entry.minOrderQty === undefined || isFiniteNumber(entry.minOrderQty)) &&
        (entry.maxOrderQty === null || entry.maxOrderQty === undefined || isFiniteNumber(entry.maxOrderQty))
      );
    });

    const filters: UniverseFilters = {
      minTurnover: isFiniteNumber(parsed.filters.minTurnover) ? parsed.filters.minTurnover : MIN_TURNOVER,
      minVolPct: parsed.filters.minVolPct
    };

    const metricDefinitionLegacy = parsed.metricDefinition && typeof parsed.metricDefinition === 'object'
      ? parsed.metricDefinition as { turnoverDefinition?: unknown; volDefinition?: unknown }
      : null;
    const metricDefinition = typeof parsed.metricDefinition === 'string'
      ? parsed.metricDefinition
      : metricDefinitionLegacy &&
          (typeof metricDefinitionLegacy.turnoverDefinition === 'string' || typeof metricDefinitionLegacy.volDefinition === 'string')
        ? `${typeof metricDefinitionLegacy.turnoverDefinition === 'string' ? metricDefinitionLegacy.turnoverDefinition : TURNOVER_DEFINITION} ${typeof metricDefinitionLegacy.volDefinition === 'string' ? metricDefinitionLegacy.volDefinition : VOLATILITY_DEFINITION}`
        : `${TURNOVER_DEFINITION} ${VOLATILITY_DEFINITION}`;

    return {
      createdAt: parsed.createdAt,
      ready: parsed.ready,
      filters,
      metricDefinition,
      symbols: symbols.map((entry) => ({
        ...entry,
        turnover24hUSDT: entry.turnover24hUSDT ?? entry.turnover24h,
        turnover24h: entry.turnover24hUSDT ?? entry.turnover24h,
        vol24hRangePct: entry.vol24hRangePct ?? entry.vol24hPct,
        vol24hPct: entry.vol24hRangePct ?? entry.vol24hPct,
        qtyStep: entry.qtyStep ?? null,
        minOrderQty: entry.minOrderQty ?? null,
        maxOrderQty: entry.maxOrderQty ?? null
      })),
      totalSymbols: isFiniteNumber(parsed.totalSymbols) ? parsed.totalSymbols : undefined,
      validSymbols: isFiniteNumber(parsed.validSymbols) ? parsed.validSymbols : undefined,
      filteredOut:
        parsed.filteredOut && isFiniteNumber(parsed.filteredOut.expiringOrNonPerp)
          ? {
              expiringOrNonPerp: parsed.filteredOut.expiringOrNonPerp,
              byMetricThreshold: isFiniteNumber(parsed.filteredOut.byMetricThreshold) ? parsed.filteredOut.byMetricThreshold : undefined,
              dataUnavailable: isFiniteNumber(parsed.filteredOut.dataUnavailable) ? parsed.filteredOut.dataUnavailable : undefined
            }
          : undefined,
      contractFilter: parsed.contractFilter === UNIVERSE_CONTRACT_FILTER ? parsed.contractFilter : undefined,
      notReadyReason: typeof parsed.notReadyReason === 'string' ? parsed.notReadyReason : undefined
    };
  }
}

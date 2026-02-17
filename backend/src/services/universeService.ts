import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { BybitApiError, type IBybitMarketClient, type InstrumentLinear, type TickerLinear } from './bybitMarketClient.js';
import { classifyUsdtLinearPerpetualInstrument, isUsdtLinearPerpetualInstrument, UNIVERSE_CONTRACT_FILTER } from './universeContractFilter.js';
import { normalizeUniverseSymbol } from './universeSymbol.js';
import type { UniverseDiagnostics, UniverseEntry, UniverseFilters, UniverseState } from '../types/universe.js';

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

export type UniverseUpstreamErrorCode = 'BYBIT_UNREACHABLE' | 'TIMEOUT' | 'BYBIT_AUTH_ERROR' | 'BYBIT_BAD_RESPONSE' | 'PARSE_ERROR' | 'UPSTREAM_RATE_LIMIT';

export type UniverseUpstreamError = {
  code: UniverseUpstreamErrorCode;
  message: string;
  hint: string;
  retryable: boolean;
};

type UniverseOperationPayload = {
  createdAt: number;
  filters: UniverseFilters;
  totals: {
    totalSymbols: number;
    validSymbols: number;
    filteredOut: NonNullable<UniverseState['filteredOut']>;
  };
  diagnostics: UniverseDiagnostics & {
    byMetricThreshold: number;
    dataUnavailable: number;
    contractFilter: typeof UNIVERSE_CONTRACT_FILTER;
    upstreamStatus: 'ok' | 'error';
    upstreamError?: UniverseUpstreamError;
  };
};

export type UniverseOperationResult =
  | ({ ok: true; ready: true; state: UniverseState; forcedActive: number } & UniverseOperationPayload)
  | ({ ok: false; ready: false; state: UniverseState | null; forcedActive: 0 } & UniverseOperationPayload);

const EMPTY_DIAGNOSTICS: UniverseDiagnostics = {
  totals: { instrumentsTotal: 0, tickersTotal: 0, matchedTotal: 0, validTotal: 0 },
  excluded: {
    nonPerp: 0,
    expiring: 0,
    nonLinear: 0,
    nonTrading: 0,
    nonUSDT: 0,
    tickerMissing: 0,
    thresholdFiltered: 0,
    parseError: 0,
    unknown: 0
  }
};

const cloneDiagnostics = (diagnostics: UniverseDiagnostics): UniverseDiagnostics => ({
  totals: { ...diagnostics.totals },
  excluded: { ...diagnostics.excluded }
});

const computeVol24hRangePct = (highPrice24h: number, lowPrice24h: number): number | null => {
  if (lowPrice24h <= 0) {
    return null;
  }

  return ((highPrice24h - lowPrice24h) / lowPrice24h) * 100;
};

export class UniverseService {
  private state: UniverseState | null = null;
  private instrumentsCache: { expiresAt: number; bySymbol: Map<string, InstrumentLinear> } | null = null;
  private lastUpstreamError: UniverseUpstreamError | null = null;

  constructor(
    private readonly marketClient: IBybitMarketClient,
    private readonly activeSymbolSet: ActiveSymbolSet,
    private readonly logger: FastifyBaseLogger,
    private readonly universeFilePath = path.resolve(process.cwd(), 'data/universe.json')
  ) {}

  async create(minVolPct: number, minTurnover: number = MIN_TURNOVER): Promise<UniverseOperationResult> {
    const createdAt = Date.now();
    const filters: UniverseFilters = { minTurnover, minVolPct };
    const built = await this.buildFilteredUniverseSafe(minVolPct, minTurnover);
    if (!built.ok) {
      this.lastUpstreamError = built.upstreamError;
      const current = this.state ?? (await this.loadFromDisk());
      return {
        ok: false,
        ready: false,
        state: current,
        forcedActive: 0,
        createdAt,
        filters,
        totals: {
          totalSymbols: 0,
          validSymbols: 0,
          filteredOut: { expiringOrNonPerp: 0, byMetricThreshold: 0, dataUnavailable: 0 }
        },
        diagnostics: {
          ...cloneDiagnostics(EMPTY_DIAGNOSTICS),
          byMetricThreshold: 0,
          dataUnavailable: 0,
          contractFilter: UNIVERSE_CONTRACT_FILTER,
          upstreamStatus: 'error',
          upstreamError: built.upstreamError
        }
      };
    }

    const nextState: UniverseState = {
      createdAt,
      filters,
      metricDefinition: METRIC_DEFINITION,
      symbols: built.built.entries,
      ready: true,
      totalSymbols: built.built.totalFetched,
      validSymbols: built.built.validCount,
      filteredOut: {
        expiringOrNonPerp:
          built.built.diagnostics.excluded.nonPerp +
          built.built.diagnostics.excluded.expiring +
          built.built.diagnostics.excluded.nonLinear +
          built.built.diagnostics.excluded.nonTrading +
          built.built.diagnostics.excluded.nonUSDT +
          built.built.diagnostics.excluded.unknown,
        byMetricThreshold: built.built.metricFilteredCount,
        dataUnavailable: built.built.dataUnavailableCount
      },
      diagnostics: built.built.diagnostics,
      contractFilter: UNIVERSE_CONTRACT_FILTER
    };

    this.state = this.normalizeBuiltState(nextState);
    await this.persist(this.state);
    this.lastUpstreamError = null;

    return {
      ok: true,
      ready: true,
      state: this.state,
      forcedActive: 0,
      createdAt,
      filters,
      totals: {
        totalSymbols: built.built.totalFetched,
        validSymbols: built.built.validCount,
        filteredOut: this.state.filteredOut ?? { expiringOrNonPerp: 0, byMetricThreshold: 0, dataUnavailable: 0 }
      },
      diagnostics: {
        ...cloneDiagnostics(built.built.diagnostics),
        byMetricThreshold: built.built.metricFilteredCount,
        dataUnavailable: built.built.dataUnavailableCount,
        contractFilter: UNIVERSE_CONTRACT_FILTER,
        upstreamStatus: 'ok'
      }
    };
  }

  async refresh(minVolPct?: number, minTurnover?: number): Promise<UniverseOperationResult | null> {
    const active = this.state ?? (await this.loadFromDisk());
    const effectiveMinVolPct = minVolPct ?? active?.filters.minVolPct;
    const effectiveMinTurnover = minTurnover ?? active?.filters.minTurnover;

    if (effectiveMinVolPct === undefined || effectiveMinTurnover === undefined) {
      return null;
    }

    const createdAt = Date.now();
    const filters: UniverseFilters = { minTurnover: effectiveMinTurnover, minVolPct: effectiveMinVolPct };
    const built = await this.buildFilteredUniverseSafe(effectiveMinVolPct, effectiveMinTurnover);
    if (!built.ok) {
      this.lastUpstreamError = built.upstreamError;
      return {
        ok: false,
        ready: false,
        state: active,
        forcedActive: 0,
        createdAt,
        filters,
        totals: {
          totalSymbols: 0,
          validSymbols: 0,
          filteredOut: { expiringOrNonPerp: 0, byMetricThreshold: 0, dataUnavailable: 0 }
        },
        diagnostics: {
          ...cloneDiagnostics(EMPTY_DIAGNOSTICS),
          byMetricThreshold: 0,
          dataUnavailable: 0,
          contractFilter: UNIVERSE_CONTRACT_FILTER,
          upstreamStatus: 'error',
          upstreamError: built.upstreamError
        }
      };
    }

    const forced = this.mergeForcedActive(built.built.entries, built.built.tickersBySymbol, built.built.instrumentBySymbol);

    const nextState: UniverseState = {
      createdAt,
      filters,
      metricDefinition: METRIC_DEFINITION,
      symbols: forced.entries,
      ready: true,
      totalSymbols: built.built.totalFetched,
      validSymbols: built.built.validCount,
      filteredOut: {
        expiringOrNonPerp:
          built.built.diagnostics.excluded.nonPerp +
          built.built.diagnostics.excluded.expiring +
          built.built.diagnostics.excluded.nonLinear +
          built.built.diagnostics.excluded.nonTrading +
          built.built.diagnostics.excluded.nonUSDT +
          built.built.diagnostics.excluded.unknown,
        byMetricThreshold: built.built.metricFilteredCount,
        dataUnavailable: built.built.dataUnavailableCount
      },
      diagnostics: built.built.diagnostics,
      contractFilter: UNIVERSE_CONTRACT_FILTER
    };

    this.state = this.normalizeBuiltState(nextState);
    await this.persist(this.state);
    this.lastUpstreamError = null;

    return {
      ok: true,
      ready: true,
      state: this.state,
      forcedActive: forced.forcedCount,
      createdAt,
      filters,
      totals: {
        totalSymbols: built.built.totalFetched,
        validSymbols: built.built.validCount,
        filteredOut: this.state.filteredOut ?? { expiringOrNonPerp: 0, byMetricThreshold: 0, dataUnavailable: 0 }
      },
      diagnostics: {
        ...cloneDiagnostics(built.built.diagnostics),
        byMetricThreshold: built.built.metricFilteredCount,
        dataUnavailable: built.built.dataUnavailableCount,
        contractFilter: UNIVERSE_CONTRACT_FILTER,
        upstreamStatus: 'ok'
      }
    };
  }

  getLastUpstreamError(): UniverseUpstreamError | null {
    return this.lastUpstreamError;
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
    diagnostics: UniverseDiagnostics;
  }> {
    if (process.env.UNIVERSE_FORCE_UPSTREAM_ERROR === '1') {
      throw new BybitApiError('Forced upstream error for QA', 'UNREACHABLE', true);
    }

    const [instruments, tickersBySymbolRaw] = await Promise.all([this.marketClient.getInstrumentsLinearAll(), this.marketClient.getTickersLinear()]);

    const instrumentBySymbol = new Map<string, InstrumentLinear>();
    for (const instrument of instruments) {
      const normalized = normalizeUniverseSymbol(instrument.symbol);
      if (!normalized) {
        continue;
      }
      instrumentBySymbol.set(normalized, instrument);
    }

    const tickersBySymbol = new Map<string, TickerLinear>();
    for (const ticker of tickersBySymbolRaw.values()) {
      const normalized = normalizeUniverseSymbol(ticker.symbol);
      if (!normalized) {
        continue;
      }
      tickersBySymbol.set(normalized, ticker);
    }

    const diagnostics = cloneDiagnostics(EMPTY_DIAGNOSTICS);
    diagnostics.totals.instrumentsTotal = instruments.length;
    diagnostics.totals.tickersTotal = tickersBySymbol.size;

    const entries: UniverseEntry[] = [];
    let validCount = 0;
    let contractEligibleCount = 0;

    for (const instrument of instruments) {
      const normalizedSymbol = normalizeUniverseSymbol(instrument.symbol);
      if (!normalizedSymbol) {
        diagnostics.excluded.unknown += 1;
        continue;
      }

      const contractVerdict = classifyUsdtLinearPerpetualInstrument(instrument);
      if (!contractVerdict.included) {
        diagnostics.excluded[contractVerdict.reason] += 1;
        continue;
      }

      contractEligibleCount += 1;

      const ticker = tickersBySymbol.get(normalizedSymbol);
      if (!ticker) {
        diagnostics.excluded.tickerMissing += 1;
        continue;
      }

      diagnostics.totals.matchedTotal += 1;

      const turnover24hUSDT = ticker.turnover24hUSDT ?? ticker.turnover24h;
      const highPrice24h = ticker.highPrice24h;
      const lowPrice24h = ticker.lowPrice24h;
      if (!isFiniteNumber(turnover24hUSDT) || !isFiniteNumber(highPrice24h) || !isFiniteNumber(lowPrice24h)) {
        diagnostics.excluded.parseError += 1;
        continue;
      }

      const vol24hRangePct = computeVol24hRangePct(highPrice24h, lowPrice24h);
      if (!isFiniteNumber(vol24hRangePct)) {
        diagnostics.excluded.parseError += 1;
        continue;
      }

      if (turnover24hUSDT >= minTurnover && vol24hRangePct >= minVolPct) {
        entries.push({
          symbol: normalizedSymbol,
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
        validCount += 1;
      } else {
        diagnostics.excluded.thresholdFiltered += 1;
      }
    }

    diagnostics.totals.validTotal = validCount;
    const dataUnavailableCount = diagnostics.excluded.tickerMissing + diagnostics.excluded.parseError;

    return {
      entries,
      totalFetched: instruments.length,
      validCount: contractEligibleCount,
      metricFilteredCount: diagnostics.excluded.thresholdFiltered,
      dataUnavailableCount,
      tickersBySymbol,
      instrumentBySymbol,
      diagnostics
    };
  }

  private async buildFilteredUniverseSafe(minVolPct: number, minTurnover: number): Promise<{ ok: true; built: Awaited<ReturnType<UniverseService['buildFilteredUniverse']>> } | { ok: false; upstreamError: UniverseUpstreamError }> {
    try {
      const built = await this.buildFilteredUniverse(minVolPct, minTurnover);
      return { ok: true, built };
    } catch (error) {
      return { ok: false, upstreamError: this.classifyUpstreamError(error) };
    }
  }

  private classifyUpstreamError(error: unknown): UniverseUpstreamError {
    if (error instanceof BybitApiError) {
      if (error.code === 'TIMEOUT') {
        return { code: 'TIMEOUT', message: error.message, hint: 'Check internet and BYBIT_REST endpoint; retry after a short delay.', retryable: error.retryable };
      }
      if (error.code === 'UNREACHABLE') {
        return { code: 'BYBIT_UNREACHABLE', message: error.message, hint: 'Bybit API is unreachable from this host. Verify DNS/firewall/proxy.', retryable: error.retryable };
      }
      if (error.code === 'AUTH_ERROR') {
        return { code: 'BYBIT_AUTH_ERROR', message: error.message, hint: 'Verify API credentials and environment routing to the correct Bybit network.', retryable: error.retryable };
      }
      if (error.code === 'RATE_LIMIT') {
        return { code: 'UPSTREAM_RATE_LIMIT', message: error.message, hint: 'Rate limit hit. Wait briefly and retry refresh.', retryable: error.retryable };
      }
      if (error.code === 'PARSE_ERROR') {
        return { code: 'PARSE_ERROR', message: error.message, hint: 'Unexpected Bybit payload format. Retry and review backend logs.', retryable: error.retryable };
      }
    }

    return {
      code: 'BYBIT_BAD_RESPONSE',
      message: (error as Error)?.message ?? 'Unexpected upstream failure',
      hint: 'Bybit responded with invalid data or unexpected status. Retry and inspect backend logs.',
      retryable: false
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

    for (const rawActiveSymbol of this.activeSymbolSet.get()) {
      const activeSymbol = normalizeUniverseSymbol(rawActiveSymbol);
      if (!activeSymbol || symbols.has(activeSymbol)) {
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
      const vol24hRangePct = isFiniteNumber(highPrice24h) && isFiniteNumber(lowPrice24h) ? computeVol24hRangePct(highPrice24h, lowPrice24h) ?? 0 : 0;

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
    const bySymbol = new Map<string, InstrumentLinear>();
    for (const instrument of instruments) {
      const normalized = normalizeUniverseSymbol(instrument.symbol);
      if (!normalized) {
        continue;
      }
      bySymbol.set(normalized, instrument);
    }

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
      const normalized = normalizeUniverseSymbol(entry.symbol);
      if (!normalized) {
        return false;
      }
      const instrument = instrumentsBySymbol.get(normalized);
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

    if (!parsed || !isFiniteNumber(parsed.createdAt) || typeof parsed.ready !== 'boolean' || !parsed.filters || !isFiniteNumber(parsed.filters.minVolPct) || !Array.isArray(parsed.symbols)) {
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

    const metricDefinitionLegacy = parsed.metricDefinition && typeof parsed.metricDefinition === 'object' ? (parsed.metricDefinition as { turnoverDefinition?: unknown; volDefinition?: unknown }) : null;
    const metricDefinition =
      typeof parsed.metricDefinition === 'string'
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
        symbol: normalizeUniverseSymbol(entry.symbol) ?? entry.symbol,
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
      diagnostics:
        parsed.diagnostics &&
        parsed.diagnostics.totals &&
        parsed.diagnostics.excluded &&
        isFiniteNumber(parsed.diagnostics.totals.instrumentsTotal) &&
        isFiniteNumber(parsed.diagnostics.totals.tickersTotal) &&
        isFiniteNumber(parsed.diagnostics.totals.matchedTotal) &&
        isFiniteNumber(parsed.diagnostics.totals.validTotal)
          ? {
              totals: {
                instrumentsTotal: parsed.diagnostics.totals.instrumentsTotal,
                tickersTotal: parsed.diagnostics.totals.tickersTotal,
                matchedTotal: parsed.diagnostics.totals.matchedTotal,
                validTotal: parsed.diagnostics.totals.validTotal
              },
              excluded: {
                nonPerp: isFiniteNumber(parsed.diagnostics.excluded.nonPerp) ? parsed.diagnostics.excluded.nonPerp : 0,
                expiring: isFiniteNumber(parsed.diagnostics.excluded.expiring) ? parsed.diagnostics.excluded.expiring : 0,
                nonLinear: isFiniteNumber(parsed.diagnostics.excluded.nonLinear) ? parsed.diagnostics.excluded.nonLinear : 0,
                nonTrading: isFiniteNumber(parsed.diagnostics.excluded.nonTrading) ? parsed.diagnostics.excluded.nonTrading : 0,
                nonUSDT: isFiniteNumber(parsed.diagnostics.excluded.nonUSDT) ? parsed.diagnostics.excluded.nonUSDT : 0,
                tickerMissing: isFiniteNumber(parsed.diagnostics.excluded.tickerMissing) ? parsed.diagnostics.excluded.tickerMissing : 0,
                thresholdFiltered: isFiniteNumber(parsed.diagnostics.excluded.thresholdFiltered) ? parsed.diagnostics.excluded.thresholdFiltered : 0,
                parseError: isFiniteNumber(parsed.diagnostics.excluded.parseError) ? parsed.diagnostics.excluded.parseError : 0,
                unknown: isFiniteNumber(parsed.diagnostics.excluded.unknown) ? parsed.diagnostics.excluded.unknown : 0
              }
            }
          : undefined,
      contractFilter: parsed.contractFilter === UNIVERSE_CONTRACT_FILTER ? parsed.contractFilter : undefined,
      notReadyReason: typeof parsed.notReadyReason === 'string' ? parsed.notReadyReason : undefined
    };
  }
}

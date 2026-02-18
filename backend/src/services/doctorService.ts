import { UNIVERSE_CONTRACT_FILTER } from './universeContractFilter.js';

type DoctorStatus = 'PASS' | 'WARN' | 'FAIL';

type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  ok: boolean;
  ts: number;
  version?: { commit?: string; node?: string };
  checks: DoctorCheck[];
  warnings?: string[];
};

type BotLifecycleState = {
  running: boolean;
  paused: boolean;
  activeOrders: number;
  openPositions: number;
  mode: string | null;
  tf: number | null;
  direction: string | null;
};

type MarketStateLike = { ts: number; lastTickTs?: number };

type UniverseStateLike = {
  contractFilter?: string;
  diagnostics?: { excluded?: Record<string, unknown> };
  filteredOut?: Record<string, unknown>;
  symbols?: Array<{ symbol: string }>;
};

type DoctorServiceDeps = {
  getBotState: () => BotLifecycleState;
  getMarketStates: () => Record<string, MarketStateLike>;
  getTrackedSymbols: () => string[];
  getTickerStreamStatus?: () => {
    running: boolean;
    connected: boolean;
    desiredSymbolsCount: number;
    subscribedCount: number;
    lastMessageAt: number | null;
    lastTickerAt: number | null;
    reconnectCount: number;
    lastError: string | null;
  };
  getUniverseState: () => Promise<UniverseStateLike | null>;
  now?: () => number;
  getVersion?: () => Promise<{ commit?: string; node?: string }>;
};

const DATED_FUTURES_PATTERN = /-[0-9]{1,2}[A-Z]{3}[0-9]{2}$/;

const phaseOf = (state: BotLifecycleState): 'STOPPED' | 'RUNNING' | 'PAUSED' => {
  if (state.paused) return 'PAUSED';
  if (state.running) return 'RUNNING';
  return 'STOPPED';
};

const computeAgeMs = (state: MarketStateLike, nowMs: number): number => {
  const tickTs = typeof state.lastTickTs === 'number' && Number.isFinite(state.lastTickTs) ? state.lastTickTs : state.ts;
  return Math.max(0, nowMs - tickTs);
};

export class DoctorService {
  private readonly now: () => number;

  constructor(private readonly deps: DoctorServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async buildReport(): Promise<DoctorReport> {
    const ts = this.now();
    const checks: DoctorCheck[] = [];
    const warnings: string[] = [];

    try {
      checks.push(this.buildWsFreshnessCheck(ts));
    } catch (error) {
      checks.push({ id: 'ws_freshness', status: 'WARN', message: 'unable to evaluate ws freshness' });
      warnings.push(`ws_freshness:${(error as Error).message}`);
    }

    try {
      checks.push(this.buildMarketAgePerSymbolCheck(ts));
    } catch (error) {
      checks.push({ id: 'market_age_per_symbol', status: 'WARN', message: 'unable to evaluate market ages' });
      warnings.push(`market_age_per_symbol:${(error as Error).message}`);
    }

    try {
      checks.push(this.buildLifecycleInvariantCheck());
    } catch (error) {
      checks.push({ id: 'lifecycle_invariants', status: 'WARN', message: 'unable to validate lifecycle invariants' });
      warnings.push(`lifecycle_invariants:${(error as Error).message}`);
    }

    try {
      checks.push(await this.buildUniverseContractFilterCheck());
    } catch (error) {
      checks.push({ id: 'universe_contract_filter', status: 'WARN', message: 'unable to validate universe contract filter' });
      warnings.push(`universe_contract_filter:${(error as Error).message}`);
    }

    const version = this.deps.getVersion ? await this.deps.getVersion().catch(() => ({ node: process.version })) : { node: process.version };
    const ok = checks.every((check) => check.status !== 'FAIL');

    return {
      ok,
      ts,
      version,
      checks,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  private buildWsFreshnessCheck(nowMs: number): DoctorCheck {
    const marketStates = this.deps.getMarketStates();
    const trackedSymbols = this.deps.getTrackedSymbols();
    const streamStatus = this.deps.getTickerStreamStatus?.();
    const desiredSymbolsCount = streamStatus?.desiredSymbolsCount ?? trackedSymbols.length;

    if (desiredSymbolsCount === 0) {
      return {
        id: 'ws_freshness',
        status: 'WARN',
        message: 'no symbols subscribed',
        details: {
          desiredSymbolsCount,
          subscribedCount: streamStatus?.subscribedCount ?? 0,
          symbolsChecked: 0,
          maxAgeMs: null,
          minAgeMs: null,
          staleSymbolsCount: 0
        }
      };
    }

    const selectedSymbols = trackedSymbols.length > 0 ? trackedSymbols : Object.keys(marketStates);
    const measured = selectedSymbols
      .map((symbol) => ({ symbol, state: marketStates[symbol] }))
      .filter((entry): entry is { symbol: string; state: MarketStateLike } => !!entry.state)
      .slice(0, 300);

    const mode = this.deps.getBotState().mode;
    const wsFreshnessThresholdMs = mode === 'paper' ? 3000 : 5000;
    const minSymbolsForFreshness = Math.max(1, Math.min(5, desiredSymbolsCount));

    if (measured.length === 0) {
      return {
        id: 'ws_freshness',
        status: streamStatus?.running ? 'FAIL' : 'WARN',
        message: streamStatus?.running ? 'market feed stream running but no ticker ages available' : 'no market feed active',
        details: {
          desiredSymbolsCount,
          subscribedCount: streamStatus?.subscribedCount ?? 0,
          symbolsChecked: 0,
          maxAgeMs: null,
          minAgeMs: null,
          staleSymbolsCount: 0,
          wsFreshnessThresholdMs,
          minSymbolsForFreshness,
          lastMessageAt: streamStatus?.lastMessageAt ?? null,
          lastTickerAt: streamStatus?.lastTickerAt ?? null,
          reconnectCount: streamStatus?.reconnectCount ?? 0,
          lastError: streamStatus?.lastError ?? null
        }
      };
    }

    const ages = measured.map((entry) => ({ symbol: entry.symbol, ageMs: computeAgeMs(entry.state, nowMs) }));
    const stale = ages.filter((entry) => entry.ageMs > wsFreshnessThresholdMs).sort((a, b) => b.ageMs - a.ageMs);
    const maxAgeMs = ages.reduce((max, entry) => Math.max(max, entry.ageMs), 0);
    const minAgeMs = ages.reduce((min, entry) => Math.min(min, entry.ageMs), Number.POSITIVE_INFINITY);

    const pass = measured.length >= minSymbolsForFreshness && (maxAgeMs <= wsFreshnessThresholdMs || stale.length === 0);

    return {
      id: 'ws_freshness',
      status: pass ? 'PASS' : 'FAIL',
      message: pass ? `market feed fresh by symbol ages (max=${maxAgeMs}ms)` : `market feed stale by symbol ages (max=${maxAgeMs}ms)`,
      details: {
        desiredSymbolsCount,
        subscribedCount: streamStatus?.subscribedCount ?? measured.length,
        symbolsChecked: measured.length,
        minSymbolsForFreshness,
        wsFreshnessThresholdMs,
        maxAgeMs,
        minAgeMs: Number.isFinite(minAgeMs) ? minAgeMs : null,
        staleSymbolsCount: stale.length,
        staleSymbols: stale.slice(0, 5),
        lastMessageAt: streamStatus?.lastMessageAt ?? null,
        lastTickerAt: streamStatus?.lastTickerAt ?? null,
        reconnectCount: streamStatus?.reconnectCount ?? 0,
        lastError: streamStatus?.lastError ?? null
      }
    };
  }


  private buildMarketAgePerSymbolCheck(nowMs: number): DoctorCheck {
    const marketStates = this.deps.getMarketStates();
    const symbols = Object.keys(marketStates).slice(0, 300);
    const worst = symbols
      .map((symbol) => ({ symbol, ageMs: computeAgeMs(marketStates[symbol], nowMs) }))
      .sort((a, b) => b.ageMs - a.ageMs)
      .slice(0, 5);

    return {
      id: 'market_age_per_symbol',
      status: worst.length === 0 ? 'WARN' : 'PASS',
      message: worst.length === 0 ? 'no tracked symbols with market state' : `top ${worst.length} symbol ages`,
      details: {
        scannedSymbols: symbols.length,
        worst
      }
    };
  }

  private buildLifecycleInvariantCheck(): DoctorCheck {
    const botState = this.deps.getBotState();
    const phase = phaseOf(botState);

    if (phase === 'STOPPED' && (botState.activeOrders > 0 || botState.openPositions > 0)) {
      return {
        id: 'lifecycle_invariants',
        status: 'FAIL',
        message: 'STOPPED requires activeOrders/openPositions to be zero',
        details: { phase, activeOrders: botState.activeOrders, openPositions: botState.openPositions }
      };
    }

    if (phase !== 'STOPPED' && (!botState.mode || botState.tf === null || !botState.direction)) {
      return {
        id: 'lifecycle_invariants',
        status: 'FAIL',
        message: 'RUNNING/PAUSED requires mode/tf/direction',
        details: { phase, mode: botState.mode, tf: botState.tf, direction: botState.direction }
      };
    }

    return {
      id: 'lifecycle_invariants',
      status: 'PASS',
      message: 'lifecycle invariants satisfied',
      details: { phase, activeOrders: botState.activeOrders, openPositions: botState.openPositions }
    };
  }

  private async buildUniverseContractFilterCheck(): Promise<DoctorCheck> {
    const universe = await this.deps.getUniverseState();
    const effectiveSymbols = this.deps.getTrackedSymbols();
    const datedSymbols = effectiveSymbols.filter((symbol) => DATED_FUTURES_PATTERN.test(symbol));

    if (datedSymbols.length > 0) {
      return {
        id: 'universe_contract_filter',
        status: 'FAIL',
        message: 'effective universe contains expiring futures symbols',
        details: { datedSymbols }
      };
    }

    if (!universe) {
      return {
        id: 'universe_contract_filter',
        status: 'WARN',
        message: 'universe not ready; contract filter cannot be fully validated',
        details: { effectiveSymbols: effectiveSymbols.length }
      };
    }

    const contractFilter = universe.contractFilter;
    const excludedCounters = universe.diagnostics?.excluded;

    if (contractFilter !== UNIVERSE_CONTRACT_FILTER) {
      return {
        id: 'universe_contract_filter',
        status: 'FAIL',
        message: 'unexpected universe contract filter',
        details: {
          expected: UNIVERSE_CONTRACT_FILTER,
          actual: contractFilter,
          excludedCounters,
          filteredOut: universe.filteredOut
        }
      };
    }

    return {
      id: 'universe_contract_filter',
      status: 'PASS',
      message: 'USDT Linear Perpetual contract filter active',
      details: {
        contractFilter,
        excludedCounters,
        filteredOut: universe.filteredOut,
        effectiveSymbols: effectiveSymbols.length,
        persistedSymbols: universe.symbols?.length ?? 0
      }
    };
  }
}

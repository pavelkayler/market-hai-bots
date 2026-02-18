import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
  getDataDir: () => string;
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

const checkWritableDir = async (targetDir: string, nowMs: number): Promise<{ ok: boolean; error?: string }> => {
  const probeName = `.doctor-${nowMs}-${Math.random().toString(16).slice(2)}.tmp`;
  const probePath = path.join(targetDir, probeName);

  try {
    await mkdir(targetDir, { recursive: true });
    await writeFile(probePath, 'ok', 'utf-8');
    await rm(probePath, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
      checks.push(await this.buildFilesystemWritableCheck(ts));
    } catch (error) {
      checks.push({ id: 'filesystem_writable', status: 'FAIL', message: 'filesystem writable check failed unexpectedly' });
      warnings.push(`filesystem_writable:${(error as Error).message}`);
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
    const tracked = this.deps.getTrackedSymbols();
    const selectedSymbols = tracked.length > 0 ? tracked : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    const measured = selectedSymbols
      .map((symbol) => ({ symbol, state: marketStates[symbol] }))
      .filter((entry): entry is { symbol: string; state: MarketStateLike } => !!entry.state)
      .slice(0, 50);

    const streamStatus = this.deps.getTickerStreamStatus?.();
    const streamDetails = streamStatus
      ? {
          streamRunning: streamStatus.running,
          streamConnected: streamStatus.connected,
          desiredSymbolsCount: streamStatus.desiredSymbolsCount,
          subscribedCount: streamStatus.subscribedCount,
          lastMessageAt: streamStatus.lastMessageAt,
          lastTickerAt: streamStatus.lastTickerAt,
          reconnectCount: streamStatus.reconnectCount,
          lastError: streamStatus.lastError
        }
      : {};

    if (measured.length === 0) {
      return {
        id: 'ws_freshness',
        status: streamStatus?.running ? 'FAIL' : 'WARN',
        message: streamStatus?.running ? 'market feed stream running but no ticker data' : 'no market feed active',
        details: streamDetails
      };
    }

    const worstAgeMs = measured.reduce((max, entry) => Math.max(max, computeAgeMs(entry.state, nowMs)), 0);
    const mode = this.deps.getBotState().mode;
    const passThresholdMs = mode === 'paper' ? 3000 : 5000;

    if (worstAgeMs > 30000) {
      return {
        id: 'ws_freshness',
        status: 'FAIL',
        message: `market feed stale (${worstAgeMs}ms)`,
        details: { worstAgeMs, passThresholdMs, symbolsChecked: measured.map((entry) => entry.symbol), ...streamDetails }
      };
    }

    if (worstAgeMs > passThresholdMs) {
      return {
        id: 'ws_freshness',
        status: 'WARN',
        message: `market feed aging (${worstAgeMs}ms)`,
        details: { worstAgeMs, passThresholdMs, symbolsChecked: measured.map((entry) => entry.symbol), ...streamDetails }
      };
    }

    return {
      id: 'ws_freshness',
      status: 'PASS',
      message: `market feed fresh (${worstAgeMs}ms)`,
      details: { worstAgeMs, passThresholdMs, symbolsChecked: measured.map((entry) => entry.symbol), ...streamDetails }
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

  private async buildFilesystemWritableCheck(nowMs: number): Promise<DoctorCheck> {
    const dataDir = this.deps.getDataDir();

    try {
      await access(dataDir);
    } catch {
      // continue with mkdir/write probe
    }

    const probe = await checkWritableDir(dataDir, nowMs);
    if (!probe.ok) {
      return {
        id: 'filesystem_writable',
        status: 'FAIL',
        message: 'data directory is not writable',
        details: { dataDir, error: probe.error }
      };
    }

    return {
      id: 'filesystem_writable',
      status: 'PASS',
      message: 'data directory writable',
      details: { dataDir }
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

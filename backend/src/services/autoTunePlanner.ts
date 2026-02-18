import type { BotConfig, BotStats } from '../bot/botEngine.js';
import type { AutoTuneScope } from './autoTuneService.js';
import type { RunSummary } from './runHistoryService.js';

export type AutoTunePlannerMode = 'DETERMINISTIC' | 'RANDOM_EXPLORE';

export type AutoTunePlannerInput = {
  currentConfig: BotConfig;
  autoTuneScope: AutoTuneScope;
  recentRuns: RunSummary[];
  currentBotStats: BotStats;
  nowMs?: number;
  plannerMode?: AutoTunePlannerMode;
};

type ConfigField = 'priceUpThrPct' | 'oiUpThrPct' | 'minNotionalUSDT' | 'signalCounterThreshold' | 'oiCandleThrPct';

export type AutoTunePlan =
  | { kind: 'CONFIG_PATCH'; patch: Partial<Pick<BotConfig, ConfigField>>; parameter: ConfigField; before: number; after: number; reason: string }
  | { kind: 'UNIVERSE_EXCLUDE'; symbol: string; reason: string }
  | null;

export const AUTO_TUNE_BOUNDS: Record<ConfigField, { min: number; max: number; step: number }> = {
  priceUpThrPct: { min: 0.1, max: 5, step: 0.05 },
  oiUpThrPct: { min: 10, max: 300, step: 5 },
  minNotionalUSDT: { min: 1, max: 100, step: 1 },
  signalCounterThreshold: { min: 1, max: 8, step: 1 },
  oiCandleThrPct: { min: 0, max: 25, step: 0.2 }
} as const;

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TARGET_TRADES_IN_WINDOW = 6;
const MIN_TRADES_BEFORE_TIGHTEN = 4;

const round = (value: number): number => Number(value.toFixed(4));
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const summarizeRecent = (recentRuns: RunSummary[], nowMs: number) => {
  const windowStart = nowMs - RECENT_WINDOW_MS;
  const withStats = recentRuns.filter((run) => run.stats && run.startedAt >= windowStart);
  const trades = withStats.reduce((sum, run) => sum + (run.stats?.totalTrades ?? 0), 0);
  const pnl = withStats.reduce((sum, run) => sum + (run.stats?.pnlUSDT ?? 0), 0);
  const fees = withStats.reduce((sum, run) => sum + (run.stats?.totalFeesUSDT ?? 0), 0);
  const slippage = withStats.reduce((sum, run) => sum + (run.stats?.totalSlippageUSDT ?? 0), 0);
  return { withStatsCount: withStats.length, trades, pnl, fees, slippage };
};

const buildPatch = (currentConfig: BotConfig, parameter: ConfigField, direction: 'tighten' | 'loosen', reason: string): AutoTunePlan => {
  const bounds = AUTO_TUNE_BOUNDS[parameter];
  const sign = direction === 'tighten' ? 1 : -1;
  const currentValue = currentConfig[parameter];
  const nextValue = round(clamp(currentValue + sign * bounds.step, bounds.min, bounds.max));

  if (nextValue === currentValue) {
    return null;
  }

  return {
    kind: 'CONFIG_PATCH',
    patch: { [parameter]: nextValue },
    parameter,
    before: currentValue,
    after: nextValue,
    reason
  };
};

const chooseParameter = (mode: AutoTunePlannerMode, preferred: ConfigField[]): ConfigField[] => {
  if (mode !== 'RANDOM_EXPLORE' || preferred.length <= 1) {
    return preferred;
  }

  const index = Math.floor(Math.random() * preferred.length);
  return [preferred[index], ...preferred.filter((_, i) => i !== index)];
};

export function planAutoTuneChange(input: AutoTunePlannerInput): AutoTunePlan {
  const { currentConfig, autoTuneScope, recentRuns, currentBotStats } = input;
  const nowMs = input.nowMs ?? Date.now();
  const plannerMode = input.plannerMode ?? 'DETERMINISTIC';

  if (autoTuneScope === 'UNIVERSE_ONLY') {
    const symbolBuckets = new Map<string, { trades: number; pnlUSDT: number }>();
    for (const run of recentRuns) {
      const runSymbols = run.tradedSymbols ?? [];
      const runTrades = run.stats?.totalTrades ?? 0;
      const runPnl = run.stats?.pnlUSDT ?? 0;
      if (runSymbols.length === 0 || runTrades <= 0) continue;
      const perSymbolTrades = runTrades / runSymbols.length;
      const perSymbolPnl = runPnl / runSymbols.length;
      for (const symbol of runSymbols) {
        const prev = symbolBuckets.get(symbol) ?? { trades: 0, pnlUSDT: 0 };
        symbolBuckets.set(symbol, {
          trades: prev.trades + perSymbolTrades,
          pnlUSDT: prev.pnlUSDT + perSymbolPnl
        });
      }
    }

    const candidates = Array.from(symbolBuckets.entries())
      .map(([symbol, stats]) => ({ symbol, ...stats }))
      .filter((entry) => entry.trades >= 3 && entry.pnlUSDT < 0)
      .sort((a, b) => a.pnlUSDT - b.pnlUSDT);

    if (candidates.length === 0) {
      return null;
    }

    return {
      kind: 'UNIVERSE_EXCLUDE',
      symbol: candidates[0].symbol,
      reason: `recent runs show negative contribution (pnl=${round(candidates[0].pnlUSDT)} over ${round(candidates[0].trades)} trades)`
    };
  }

  const recent = summarizeRecent(recentRuns, nowMs);
  const recentTrades = recent.trades;
  const observedPnl = recent.withStatsCount > 0 ? recent.pnl : currentBotStats.pnlUSDT;

  if (recentTrades < TARGET_TRADES_IN_WINDOW) {
    for (const parameter of chooseParameter(plannerMode, ['priceUpThrPct', 'oiUpThrPct', 'signalCounterThreshold', 'oiCandleThrPct'])) {
      const plan = buildPatch(currentConfig, parameter, 'loosen', `recent trade count ${recentTrades} < ${TARGET_TRADES_IN_WINDOW}; loosening`);
      if (plan) {
        return plan;
      }
    }
  }

  if (observedPnl < 0 && recentTrades >= MIN_TRADES_BEFORE_TIGHTEN) {
    for (const parameter of chooseParameter(plannerMode, ['priceUpThrPct', 'oiUpThrPct', 'oiCandleThrPct'])) {
      const plan = buildPatch(currentConfig, parameter, 'tighten', `negative pnl (${round(observedPnl)}) with ${recentTrades} recent trades; tightening`);
      if (plan) {
        return plan;
      }
    }
  }

  const feesPlusSlippage = recent.withStatsCount > 0 ? recent.fees + recent.slippage : currentBotStats.totalFeesUSDT + currentBotStats.totalSlippageUSDT;
  const gross = Math.abs(observedPnl) + feesPlusSlippage;
  const frictionShare = gross > 0 ? feesPlusSlippage / gross : 0;
  if (recentTrades >= 4 && frictionShare >= 0.5) {
    return buildPatch(currentConfig, 'minNotionalUSDT', 'tighten', 'fees/slippage share is high; increasing min notional');
  }

  return null;
}

import type { BotConfig, BotStats } from '../bot/botEngine.js';
import type { AutoTuneScope } from './autoTuneService.js';
import type { RunSummary } from './runHistoryService.js';

export type AutoTunePlannerInput = {
  currentConfig: BotConfig;
  autoTuneScope: AutoTuneScope;
  recentRuns: RunSummary[];
  currentBotStats: BotStats;
};

type ConfigField = 'priceUpThrPct' | 'oiUpThrPct' | 'minNotionalUSDT';

export type AutoTunePlan =
  | { kind: 'CONFIG_PATCH'; patch: Partial<Pick<BotConfig, ConfigField>>; parameter: ConfigField; before: number; after: number; reason: string }
  | { kind: 'UNIVERSE_EXCLUDE'; symbol: string; reason: string }
  | null;

const BOUNDS = {
  priceUpThrPct: { min: 0.1, max: 5, step: 0.05 },
  oiUpThrPct: { min: 10, max: 300, step: 5 },
  minNotionalUSDT: { min: 1, max: 100, step: 1 }
} as const;

const round = (value: number): number => Number(value.toFixed(4));

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const summarizeRecent = (recentRuns: RunSummary[]) => {
  const withStats = recentRuns.filter((run) => run.stats);
  const trades = withStats.reduce((sum, run) => sum + (run.stats?.totalTrades ?? 0), 0);
  const pnl = withStats.reduce((sum, run) => sum + (run.stats?.pnlUSDT ?? 0), 0);
  const fees = withStats.reduce((sum, run) => sum + (run.stats?.totalFeesUSDT ?? 0), 0);
  const slippage = withStats.reduce((sum, run) => sum + (run.stats?.totalSlippageUSDT ?? 0), 0);
  return { withStatsCount: withStats.length, trades, pnl, fees, slippage };
};

export function planAutoTuneChange(input: AutoTunePlannerInput): AutoTunePlan {
  const { currentConfig, autoTuneScope, recentRuns, currentBotStats } = input;

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

  const recent = summarizeRecent(recentRuns);
  const totalTradesObserved = Math.max(currentBotStats.totalTrades, recent.trades);
  const observedPnl = recent.withStatsCount > 0 ? recent.pnl : currentBotStats.pnlUSDT;

  if (totalTradesObserved <= 2) {
    const nextPrice = round(clamp(currentConfig.priceUpThrPct - BOUNDS.priceUpThrPct.step, BOUNDS.priceUpThrPct.min, BOUNDS.priceUpThrPct.max));
    if (nextPrice !== currentConfig.priceUpThrPct) {
      return {
        kind: 'CONFIG_PATCH',
        patch: { priceUpThrPct: nextPrice },
        parameter: 'priceUpThrPct',
        before: currentConfig.priceUpThrPct,
        after: nextPrice,
        reason: 'too few trades observed; relaxing price threshold'
      };
    }

    const nextOi = round(clamp(currentConfig.oiUpThrPct - BOUNDS.oiUpThrPct.step, BOUNDS.oiUpThrPct.min, BOUNDS.oiUpThrPct.max));
    if (nextOi !== currentConfig.oiUpThrPct) {
      return {
        kind: 'CONFIG_PATCH',
        patch: { oiUpThrPct: nextOi },
        parameter: 'oiUpThrPct',
        before: currentConfig.oiUpThrPct,
        after: nextOi,
        reason: 'too few trades observed; relaxing OI threshold'
      };
    }
  }

  if (totalTradesObserved >= 6 && observedPnl < 0) {
    const nextPrice = round(clamp(currentConfig.priceUpThrPct + BOUNDS.priceUpThrPct.step, BOUNDS.priceUpThrPct.min, BOUNDS.priceUpThrPct.max));
    if (nextPrice !== currentConfig.priceUpThrPct) {
      return {
        kind: 'CONFIG_PATCH',
        patch: { priceUpThrPct: nextPrice },
        parameter: 'priceUpThrPct',
        before: currentConfig.priceUpThrPct,
        after: nextPrice,
        reason: 'negative pnl with enough trades; tightening price threshold'
      };
    }

    const nextOi = round(clamp(currentConfig.oiUpThrPct + BOUNDS.oiUpThrPct.step, BOUNDS.oiUpThrPct.min, BOUNDS.oiUpThrPct.max));
    if (nextOi !== currentConfig.oiUpThrPct) {
      return {
        kind: 'CONFIG_PATCH',
        patch: { oiUpThrPct: nextOi },
        parameter: 'oiUpThrPct',
        before: currentConfig.oiUpThrPct,
        after: nextOi,
        reason: 'negative pnl with enough trades; tightening OI threshold'
      };
    }
  }

  const feesPlusSlippage = currentBotStats.totalFeesUSDT + currentBotStats.totalSlippageUSDT;
  const gross = Math.abs(currentBotStats.pnlUSDT) + feesPlusSlippage;
  const frictionShare = gross > 0 ? feesPlusSlippage / gross : 0;
  if (currentBotStats.totalTrades >= 4 && frictionShare >= 0.5) {
    const nextNotional = round(clamp(currentConfig.minNotionalUSDT + BOUNDS.minNotionalUSDT.step, BOUNDS.minNotionalUSDT.min, BOUNDS.minNotionalUSDT.max));
    if (nextNotional !== currentConfig.minNotionalUSDT) {
      return {
        kind: 'CONFIG_PATCH',
        patch: { minNotionalUSDT: nextNotional },
        parameter: 'minNotionalUSDT',
        before: currentConfig.minNotionalUSDT,
        after: nextNotional,
        reason: 'fees/slippage share is high; increasing min notional'
      };
    }
  }

  return null;
}

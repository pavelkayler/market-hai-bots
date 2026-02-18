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
  rng?: () => number;
};

type ConfigField =
  | 'priceUpThrPct'
  | 'oiUpThrPct'
  | 'minNotionalUSDT'
  | 'signalCounterThreshold'
  | 'oiCandleThrPct'
  | 'confirmMinContinuationPct'
  | 'confirmWindowBars'
  | 'impulseMaxAgeBars'
  | 'maxSecondsIntoCandle'
  | 'maxSpreadBps'
  | 'maxTickStalenessMs';

export type AutoTunePlan =
  | { kind: 'CONFIG_PATCH'; patch: Partial<Pick<BotConfig, ConfigField>>; parameter: ConfigField; before: number; after: number; reason: string }
  | { kind: 'UNIVERSE_EXCLUDE'; symbol: string; reason: string }
  | null;

export const AUTO_TUNE_BOUNDS: Record<ConfigField, { min: number; max: number; step: number }> = {
  priceUpThrPct: { min: 0.1, max: 5, step: 0.05 },
  oiUpThrPct: { min: 10, max: 300, step: 5 },
  minNotionalUSDT: { min: 1, max: 100, step: 1 },
  signalCounterThreshold: { min: 1, max: 8, step: 1 },
  oiCandleThrPct: { min: 0, max: 25, step: 0.2 },
  confirmMinContinuationPct: { min: 0, max: 10, step: 0.1 },
  confirmWindowBars: { min: 1, max: 5, step: 1 },
  impulseMaxAgeBars: { min: 1, max: 10, step: 1 },
  maxSecondsIntoCandle: { min: 0, max: 300, step: 5 },
  maxSpreadBps: { min: 0, max: 150, step: 2.5 },
  maxTickStalenessMs: { min: 0, max: 10_000, step: 250 }
} as const;

const AUTO_TUNE_TIGHTEN_SIGN: Record<ConfigField, 1 | -1> = {
  priceUpThrPct: 1,
  oiUpThrPct: 1,
  minNotionalUSDT: 1,
  signalCounterThreshold: 1,
  oiCandleThrPct: 1,
  confirmMinContinuationPct: 1,
  confirmWindowBars: -1,
  impulseMaxAgeBars: -1,
  maxSecondsIntoCandle: -1,
  maxSpreadBps: -1,
  maxTickStalenessMs: -1
};

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TARGET_TRADES_IN_WINDOW = 6;
const DEFAULT_MIN_TRADES_BEFORE_TIGHTEN = 4;

const round = (value: number): number => Number(value.toFixed(4));
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeWindowMs = (hours: number): number => {
  if (!Number.isFinite(hours)) {
    return DEFAULT_RECENT_WINDOW_MS;
  }
  const safeHours = Math.max(0, Math.min(7 * 24, hours));
  return safeHours * 60 * 60 * 1000;
};

const summarizeRecent = (recentRuns: RunSummary[], nowMs: number, windowMs: number) => {
  const windowStart = nowMs - windowMs;
  const withStats = recentRuns.filter((run) => run.stats && run.startedAt >= windowStart);
  const trades = withStats.reduce((sum, run) => sum + (run.stats?.totalTrades ?? 0), 0);
  const pnl = withStats.reduce((sum, run) => sum + (run.stats?.pnlUSDT ?? 0), 0);
  const fees = withStats.reduce((sum, run) => sum + (run.stats?.totalFeesUSDT ?? 0), 0);
  const slippage = withStats.reduce((sum, run) => sum + (run.stats?.totalSlippageUSDT ?? 0), 0);
  return { withStatsCount: withStats.length, trades, pnl, fees, slippage };
};

const normalizeByField = (parameter: ConfigField, value: number): number => {
  if (parameter === 'signalCounterThreshold' || parameter === 'confirmWindowBars' || parameter === 'impulseMaxAgeBars' || parameter === 'maxSecondsIntoCandle' || parameter === 'maxTickStalenessMs') {
    return Math.floor(value);
  }
  return round(value);
};

const buildPatch = (currentConfig: BotConfig, parameter: ConfigField, direction: 'tighten' | 'loosen', reason: string): AutoTunePlan => {
  const bounds = AUTO_TUNE_BOUNDS[parameter];
  const tightenSign = AUTO_TUNE_TIGHTEN_SIGN[parameter];
  const currentValue = currentConfig[parameter];
  const signedStep = direction === 'tighten' ? tightenSign * bounds.step : -tightenSign * bounds.step;
  const nextValue = normalizeByField(parameter, clamp(currentValue + signedStep, bounds.min, bounds.max));

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

const chooseParameter = (mode: AutoTunePlannerMode, preferred: ConfigField[], rng?: () => number): ConfigField[] => {
  if (mode !== 'RANDOM_EXPLORE' || preferred.length <= 1) {
    return preferred;
  }

  const random = rng ?? (() => 0.5);
  const queue = [...preferred];
  for (let i = queue.length - 1; i > 0; i -= 1) {
    const roll = Math.min(0.999999999, Math.max(0, random()));
    const swapIndex = Math.floor(roll * (i + 1));
    [queue[i], queue[swapIndex]] = [queue[swapIndex], queue[i]];
  }
  return queue;
};

export function planAutoTuneChange(input: AutoTunePlannerInput): AutoTunePlan {
  const { currentConfig, autoTuneScope, recentRuns, currentBotStats } = input;
  const nowMs = input.nowMs ?? Date.now();
  const plannerMode = input.plannerMode ?? 'DETERMINISTIC';
  const targetTrades = Math.max(0, Math.floor(currentConfig.autoTuneTargetTradesInWindow ?? DEFAULT_TARGET_TRADES_IN_WINDOW));
  const minTradesBeforeTighten = Math.max(0, Math.floor(currentConfig.autoTuneMinTradesBeforeTighten ?? DEFAULT_MIN_TRADES_BEFORE_TIGHTEN));
  const recentWindowMs = normalizeWindowMs(currentConfig.autoTuneWindowHours ?? 24);

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

  const recent = summarizeRecent(recentRuns, nowMs, recentWindowMs);
  const recentTrades = recent.trades;
  const observedPnl = recent.withStatsCount > 0 ? recent.pnl : currentBotStats.pnlUSDT;

  const starvationLevers: ConfigField[] = [
    'priceUpThrPct',
    'oiUpThrPct',
    'signalCounterThreshold',
    'oiCandleThrPct',
    'confirmMinContinuationPct',
    'confirmWindowBars',
    'impulseMaxAgeBars',
    'maxSecondsIntoCandle',
    'maxSpreadBps',
    'maxTickStalenessMs',
    'minNotionalUSDT'
  ];

  if (recentTrades < targetTrades) {
    for (const parameter of chooseParameter(plannerMode, starvationLevers, input.rng)) {
      const plan = buildPatch(currentConfig, parameter, 'loosen', `recent trade count ${recentTrades} < ${targetTrades}; loosening`);
      if (plan) {
        return plan;
      }
    }
  }

  const tighteningLevers: ConfigField[] = [
    'priceUpThrPct',
    'oiUpThrPct',
    'oiCandleThrPct',
    'confirmMinContinuationPct',
    'maxSecondsIntoCandle',
    'maxSpreadBps',
    'maxTickStalenessMs',
    'signalCounterThreshold'
  ];

  if (observedPnl < 0 && recentTrades >= minTradesBeforeTighten) {
    for (const parameter of chooseParameter(plannerMode, tighteningLevers, input.rng)) {
      const plan = buildPatch(currentConfig, parameter, 'tighten', `negative pnl (${round(observedPnl)}) with ${recentTrades} recent trades; tightening`);
      if (plan) {
        return plan;
      }
    }
  }

  const feesPlusSlippage = recent.withStatsCount > 0 ? recent.fees + recent.slippage : currentBotStats.totalFeesUSDT + currentBotStats.totalSlippageUSDT;
  const gross = Math.abs(observedPnl) + feesPlusSlippage;
  const frictionShare = gross > 0 ? feesPlusSlippage / gross : 0;
  if (recentTrades >= Math.max(4, minTradesBeforeTighten) && frictionShare >= 0.5) {
    return buildPatch(currentConfig, 'minNotionalUSDT', 'tighten', 'fees/slippage share is high; increasing min notional');
  }

  return null;
}

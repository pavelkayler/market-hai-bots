import { describe, expect, it } from 'vitest';

import { normalizeBotConfig, type BotStats } from '../src/bot/botEngine.js';
import { planAutoTuneChange } from '../src/services/autoTunePlanner.js';

const baseConfig = normalizeBotConfig({
  mode: 'paper', direction: 'both', tf: 1, holdSeconds: 1, signalCounterThreshold: 1,
  priceUpThrPct: 0.5, oiUpThrPct: 50, oiCandleThrPct: 0, marginUSDT: 100, leverage: 2,
  tpRoiPct: 1, slRoiPct: 1, entryOffsetPct: 0, minNotionalUSDT: 5
})!;

const baseStats: BotStats = {
  totalTrades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0, avgWinUSDT: null, avgLossUSDT: null, lossStreak: 0,
  todayPnlUSDT: 0, guardrailPauseReason: null,
  long: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
  short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
  reasonCounts: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
  signalsConfirmed: 0,
  signalsBySide: { long: 0, short: 0 },
  signalsByEntryReason: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
  bothHadBothCount: 0, bothChosenLongCount: 0, bothChosenShortCount: 0, bothTieBreakMode: 'shortPriority',
  totalFeesUSDT: 0, totalSlippageUSDT: 0, avgSpreadBpsEntry: null, avgSpreadBpsExit: null, expectancyUSDT: null,
  profitFactor: null, avgFeePerTradeUSDT: null, avgNetPerTradeUSDT: null
};

describe('planAutoTuneChange', () => {
  it('returns single deterministic config patch for GLOBAL too-few-trades case', () => {
    const plan = planAutoTuneChange({ currentConfig: baseConfig, autoTuneScope: 'GLOBAL', recentRuns: [], currentBotStats: baseStats });
    expect(plan).toMatchObject({ kind: 'CONFIG_PATCH', parameter: 'priceUpThrPct', after: 0.45 });
  });

  it('respects bounds when parameter is near floor/ceil', () => {
    const plan = planAutoTuneChange({
      currentConfig: { ...baseConfig, priceUpThrPct: 0.1, oiUpThrPct: 10 },
      autoTuneScope: 'GLOBAL',
      recentRuns: [],
      currentBotStats: baseStats
    });
    expect(plan).toBeNull();
  });

  it('GLOBAL scope never returns universe exclusion', () => {
    const plan = planAutoTuneChange({
      currentConfig: baseConfig,
      autoTuneScope: 'GLOBAL',
      recentRuns: [{ id: '1', startedAt: 1, endedAt: null, hasStats: true, stats: { totalTrades: 10, winratePct: 10, pnlUSDT: -100 }, tradedSymbols: ['BTCUSDT'] }],
      currentBotStats: { ...baseStats, totalTrades: 10, pnlUSDT: -20 }
    });
    expect(plan?.kind).toBe('CONFIG_PATCH');
  });

  it('UNIVERSE_ONLY scope never returns config patch', () => {
    const plan = planAutoTuneChange({
      currentConfig: baseConfig,
      autoTuneScope: 'UNIVERSE_ONLY',
      recentRuns: [{ id: '1', startedAt: 1, endedAt: null, hasStats: true, stats: { totalTrades: 6, winratePct: 10, pnlUSDT: -90 }, tradedSymbols: ['BTCUSDT'] }],
      currentBotStats: { ...baseStats, totalTrades: 10, pnlUSDT: -20 }
    });
    expect(plan).toMatchObject({ kind: 'UNIVERSE_EXCLUDE', symbol: 'BTCUSDT' });
  });
});

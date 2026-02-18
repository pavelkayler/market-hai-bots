import { describe, expect, it } from 'vitest';

import { normalizeBotConfig, type BotStats } from '../src/bot/botEngine.js';
import { planAutoTuneChange } from '../src/services/autoTunePlanner.js';

const nowMs = 1_700_000_000_000;

const baseConfig = normalizeBotConfig({
  mode: 'paper', direction: 'both', tf: 1, holdSeconds: 1, signalCounterThreshold: 2,
  priceUpThrPct: 0.5, oiUpThrPct: 50, oiCandleThrPct: 0.4, marginUSDT: 100, leverage: 2,
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
  it('low recent trades loosens instead of tightening even with negative pnl', () => {
    const plan = planAutoTuneChange({
      currentConfig: baseConfig,
      autoTuneScope: 'GLOBAL',
      recentRuns: [{ id: '1', startedAt: nowMs - 1000, endedAt: nowMs, hasStats: true, stats: { totalTrades: 1, winratePct: 0, pnlUSDT: -100 }, tradedSymbols: ['BTCUSDT'] }],
      currentBotStats: { ...baseStats, totalTrades: 12, pnlUSDT: -100 },
      nowMs
    });

    expect(plan).toMatchObject({ kind: 'CONFIG_PATCH', reason: expect.stringContaining('loosening') });
  });

  it('negative pnl with enough recent trades can tighten', () => {
    const plan = planAutoTuneChange({
      currentConfig: baseConfig,
      autoTuneScope: 'GLOBAL',
      recentRuns: [{ id: '1', startedAt: nowMs - 1000, endedAt: nowMs, hasStats: true, stats: { totalTrades: 12, winratePct: 0, pnlUSDT: -20 }, tradedSymbols: ['BTCUSDT'] }],
      currentBotStats: { ...baseStats, totalTrades: 12, pnlUSDT: -20 },
      nowMs
    });

    expect(plan).toMatchObject({ kind: 'CONFIG_PATCH', reason: expect.stringContaining('tightening') });
  });

  it('can tune non-price parameters', () => {
    const plan = planAutoTuneChange({
      currentConfig: { ...baseConfig, priceUpThrPct: 0.1 },
      autoTuneScope: 'GLOBAL',
      recentRuns: [],
      currentBotStats: baseStats,
      nowMs
    });

    expect(plan?.kind).toBe('CONFIG_PATCH');
    expect(['oiUpThrPct', 'signalCounterThreshold', 'oiCandleThrPct']).toContain((plan as { parameter?: string })?.parameter);
  });
});

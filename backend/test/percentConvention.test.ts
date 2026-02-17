import { describe, expect, it } from 'vitest';

import { normalizeBotConfig } from '../src/bot/botEngine.js';
import { percentToFraction } from '../src/utils/percent.js';

describe('percent input convention', () => {
  it('keeps Pct settings as percent units where 3 means 3%', () => {
    const normalized = normalizeBotConfig({
      mode: 'paper',
      direction: 'both',
      tf: 1,
      holdSeconds: 1,
      signalCounterThreshold: 2,
      priceUpThrPct: 3,
      oiUpThrPct: 3,
      oiCandleThrPct: 3,
      marginUSDT: 100,
      leverage: 10,
      tpRoiPct: 3,
      slRoiPct: 3,
      entryOffsetPct: 3,
      maxActiveSymbols: 3,
      dailyLossLimitUSDT: 0,
      maxConsecutiveLosses: 0,
      trendTfMinutes: 5,
      trendLookbackBars: 20,
      trendMinMovePct: 3,
      confirmWindowBars: 2,
      confirmMinContinuationPct: 3,
      impulseMaxAgeBars: 2,
      requireOiTwoCandles: false,
      maxSecondsIntoCandle: 45,
      minSpreadBps: 0,
      minNotionalUSDT: 5
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.priceUpThrPct).toBe(3);
    expect(normalized?.oiUpThrPct).toBe(3);
    expect(normalized?.oiCandleThrPct).toBe(3);
    expect(normalized?.trendMinMovePct).toBe(3);
    expect(normalized?.confirmMinContinuationPct).toBe(3);
  });

  it('converts ROI percent to price move fraction via leverage and /100', () => {
    const roiPct = 3;
    const leverage = 10;
    expect(percentToFraction(roiPct / leverage)).toBeCloseTo(0.003);
  });
});

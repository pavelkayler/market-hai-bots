import { describe, expect, it } from 'vitest';

import { computePnlBreakdown } from '../src/utils/pnlMath.js';

describe('computePnlBreakdown', () => {
  it('computes profitable LONG with fees and slippage', () => {
    const result = computePnlBreakdown({
      side: 'LONG',
      qty: 2,
      entryPrice: 100,
      exitPrice: 105,
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      slippageUSDT: 1
    });

    expect(result.grossPnlUSDT).toBeCloseTo(10, 8);
    expect(result.feeTotalUSDT).toBeCloseTo(0.2 + 0.21, 8);
    expect(result.netPnlUSDT).toBeCloseTo(10 - 0.41 - 1, 8);
  });

  it('computes profitable SHORT symmetrically', () => {
    const result = computePnlBreakdown({
      side: 'SHORT',
      qty: 1.5,
      entryPrice: 105,
      exitPrice: 100,
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      slippageUSDT: 0
    });

    expect(result.grossPnlUSDT).toBeCloseTo(7.5, 8);
    expect(result.netPnlUSDT).toBeCloseTo(7.5 - (0.1575 + 0.15), 8);
  });

  it('computes losing trades for both sides', () => {
    const longLoss = computePnlBreakdown({
      side: 'LONG',
      qty: 1,
      entryPrice: 100,
      exitPrice: 98,
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      slippageUSDT: 0
    });
    const shortLoss = computePnlBreakdown({
      side: 'SHORT',
      qty: 1,
      entryPrice: 100,
      exitPrice: 102,
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      slippageUSDT: 0
    });

    expect(longLoss.netPnlUSDT).toBeLessThan(0);
    expect(shortLoss.netPnlUSDT).toBeLessThan(0);
  });
});

import { describe, expect, it } from 'vitest';

import { FUNDING_MAX_AGE_MS, classifyFundingSnapshot, normalizeEpochToMs } from '../src/market/fundingSnapshotService.js';

describe('fundingSnapshotService helpers', () => {
  it('normalizes epoch in seconds and milliseconds', () => {
    expect(normalizeEpochToMs(1_710_000_000)).toBe(1_710_000_000_000);
    expect(normalizeEpochToMs(1_710_000_000_000)).toBe(1_710_000_000_000);
    expect(normalizeEpochToMs('1710000000')).toBe(1_710_000_000_000);
  });

  it('classifies stale funding when age exceeds 11 minutes', () => {
    const nowMs = 1_710_000_000_000;
    const stale = classifyFundingSnapshot(
      {
        fundingRate: 0.0001,
        nextFundingTimeMs: nowMs + 60_000,
        fetchedAtMs: nowMs - FUNDING_MAX_AGE_MS - 1,
        source: 'REST_TICKERS'
      },
      nowMs
    );

    expect(stale.fundingStatus).toBe('STALE');
    expect(stale.fundingRate).toBeNull();
    expect(stale.nextFundingTimeMs).toBeNull();
  });

  it('classifies missing funding rate while keeping timing diagnostics', () => {
    const nowMs = 1_710_000_000_000;
    const missing = classifyFundingSnapshot(
      {
        fundingRate: null,
        nextFundingTimeMs: nowMs + 60_000,
        fetchedAtMs: nowMs - 10_000,
        source: 'REST_TICKERS'
      },
      nowMs
    );

    expect(missing.fundingStatus).toBe('MISSING');
    expect(missing.nextFundingTimeMs).toBe(nowMs + 60_000);
    expect(missing.fundingAgeMs).toBe(10_000);
  });
});

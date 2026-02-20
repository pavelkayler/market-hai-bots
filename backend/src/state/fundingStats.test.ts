import { describe, it, expect } from "vitest";
import { computeFundingBuckets } from "./fundingStats.js";

describe("computeFundingBuckets", () => {
  it("groups trades by abs funding buckets and sign", () => {
    const trades: any[] = [
      { status: "CLOSED", pnlUSDT: 1, pnlRoiPct: 1, fundingRateAtEntry: 0.00008, fundingAbsAtEntry: 0.00008, entryFeeUSDT: 0.01, exitFeeUSDT: 0.01 },
      { status: "CLOSED", pnlUSDT: -1, pnlRoiPct: -1, fundingRateAtEntry: -0.00008, fundingAbsAtEntry: 0.00008, entryFeeUSDT: 0.01, exitFeeUSDT: 0.01 },
      { status: "CLOSED", pnlUSDT: 2, pnlRoiPct: 2, fundingRateAtEntry: 0.0003, fundingAbsAtEntry: 0.0003, entryFeeUSDT: 0.01, exitFeeUSDT: 0.01 },
    ];

    const rows = computeFundingBuckets(trades as any);
    const allBucket = rows.find((r) => r.bucket === "0.005%-0.010%" && r.sign === "ALL");
    expect(allBucket).toBeTruthy();
    expect(allBucket!.trades).toBe(2);
    expect(allBucket!.wins).toBe(1);
    expect(allBucket!.losses).toBe(1);

    const posBucket = rows.find((r) => r.bucket === "0.005%-0.010%" && r.sign === "POS");
    const negBucket = rows.find((r) => r.bucket === "0.005%-0.010%" && r.sign === "NEG");
    expect(posBucket!.trades).toBe(1);
    expect(negBucket!.trades).toBe(1);
  });
});

import { describe, it, expect } from "vitest";
import { Store } from "./store.js";

describe("feesSummary in snapshot", () => {
  it("aggregates entry/exit fees across tradeHistory and openPositions", () => {
    const s = new Store();

    (s as any).tradeHistory.push({
      id: "t1",
      symbol: "AAA",
      side: "Long",
      entryPrice: 100,
      exitPrice: 110,
      qty: 1,
      marginUSDT: 100,
      leverage: 10,
      openedAtMs: 0,
      closedAtMs: 1,
      status: "CLOSED",
      pnlUSDT: 9.923,
      pnlRoiPct: 9.923,
      entryFeeUSDT: 0.055,
      exitFeeUSDT: 0.022,
      isRecorded: true,
    });

    (s as any).openPositions.push({
      id: "p2",
      symbol: "BBB",
      side: "Short",
      entryPrice: 50,
      qty: 2,
      marginUSDT: 100,
      leverage: 10,
      openedAtMs: 0,
      status: "OPEN",
      entryFeeUSDT: 0.055,
    });

    const snap = s.snapshot();
    expect(snap.feesSummary.entryFeesUSDT).toBeCloseTo(0.11, 10);
    expect(snap.feesSummary.exitFeesUSDT).toBeCloseTo(0.022, 10);
    expect(snap.feesSummary.totalFeesUSDT).toBeCloseTo(0.132, 10);
  });
});

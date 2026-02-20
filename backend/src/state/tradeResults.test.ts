import { describe, it, expect } from "vitest";
import { createStore } from "./store.js";

describe("tradeResults aggregation (Step 16)", () => {
  it("aggregates wins/losses, pnl and roi", () => {
    const s = createStore();
    s.tradeHistory = [
      { id:"1", symbol:"AAA", side:"Long", entryPrice:1, qty:1, marginUSDT:100, leverage:10, openedAtMs:0, status:"CLOSED", pnlUSDT: 2, pnlRoiPct: 2 } as any,
      { id:"2", symbol:"AAA", side:"Long", entryPrice:1, qty:1, marginUSDT:100, leverage:10, openedAtMs:0, status:"CLOSED", pnlUSDT: -1, pnlRoiPct: -1 } as any,
      { id:"3", symbol:"BBB", side:"Short", entryPrice:1, qty:1, marginUSDT:100, leverage:10, openedAtMs:0, status:"CLOSED", pnlUSDT: 0.5, pnlRoiPct: 0.5 } as any,
    ] as any;

    const snap = s.snapshot();
    const a = snap.tradeResults.find((r) => r.symbol === "AAA")!;
    expect(a.trades).toBe(2);
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.netPnlUSDT).toBeCloseTo(1, 8);
    expect(a.netRoiPct).toBeCloseTo(1, 8);
    expect(a.winRatePct).toBeCloseTo(50, 8);
  });
});

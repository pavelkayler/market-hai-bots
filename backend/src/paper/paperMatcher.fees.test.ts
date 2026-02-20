import { describe, it, expect } from "vitest";
import { PaperMatcher } from "./paperMatcher.js";

describe("paperMatcher fees (Step 18)", () => {
  it("reduces realized pnl by entry+exit fees", () => {
    const matcher = new PaperMatcher();
    const now = Date.now();

    const symbol: any = {
      symbol: "AAA",
      markPrice: 101.5,
      fundingRate: 0.01,
      nextFundingTimeMs: now + 10_000,
      status: "POSITION_OPEN",
      reason: "",
    };

    const openPositions: any[] = [
      {
        id: "p1",
        symbol: "AAA",
        side: "Long",
        entryPrice: 100,
        qty: 1,
        marginUSDT: 100,
        leverage: 10,
        openedAtMs: now - 5_000,
        status: "OPEN",
        entryFeeUSDT: 0.055,
      },
    ];

    const tradeHistory: any[] = [];

    matcher.exitPositions({
      nowMs: now,
      botConfig: { tpRoiPct: 1, slRoiPct: 100 } as any,
      symbol,
      positions: openPositions,
      tradeHistory,
    });

    const closed = openPositions[0];
    expect(closed.status).toBe("CLOSED");
    expect(closed.exitFeeUSDT).toBeGreaterThan(0);
    expect(closed.pnlUSDT).toBeLessThan((closed.exitPrice - closed.entryPrice) * closed.qty);
    expect(tradeHistory).toHaveLength(1);
  });
});

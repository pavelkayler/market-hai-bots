import { describe, it, expect } from "vitest";
import { paperMatchOnce } from "./paperMatcher.js";

describe("paperMatcher fees (Step 18)", () => {
  it("reduces realized pnl by entry+exit fees", () => {
    const now = Date.now();
    const store: any = {
      symbols: [{ symbol: "AAA", markPrice: 1000 }],
      openOrders: [],
      openPositions: [
        {
          id: "p1",
          symbol: "AAA",
          side: "Long",
          entryPrice: 100,
          qty: 1,
          marginUSDT: 100,
          leverage: 10,
          openedAtMs: 0,
          status: "OPEN",
          entryFeeUSDT: 0.055,
        },
      ],
      tradeHistory: [],
      configs: { botConfig: { takeProfitRoiPct: 1, stopLossRoiPct: 100 } },
    };

    paperMatchOnce(store, now);

    const closed = store.openPositions[0];
    expect(closed.status).toBe("CLOSED");
    expect(closed.exitFeeUSDT).toBeGreaterThan(0);
    expect(closed.pnlUSDT).toBeLessThan((closed.exitPrice - closed.entryPrice) * closed.qty);
  });
});

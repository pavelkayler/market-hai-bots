import { describe, it, expect } from "vitest";
import { createStore, resetStore } from "./store.js";

describe("resetStore (Step 16)", () => {
  it("resets configs, clears state, sets STOPPED", () => {
    const s = createStore();
    s.botRunState = "RUNNING";
    s.universeConfig.minVolatilityPct = 9;
    s.botConfig.leverage = 25 as any;
    s.symbols = [{ symbol: "AAA", markPrice: 1, priceDeltaPct: 0, oiValue: 0, oiDeltaPct: 0, fundingRate: 0, fundingTimeMs: 0, nextFundingTimeMs: 0, status: "WAITING_TRIGGER", reason: "", triggerCountToday: 0 }] as any;
    s.openOrders = [{ id: "o", symbol: "AAA", side: "Buy", entryPrice: 1, createdAtMs: 0, status: "OPEN" }] as any;
    s.openPositions = [{ id: "p", symbol: "AAA", side: "Long", entryPrice: 1, qty: 1, marginUSDT: 100, leverage: 10, openedAtMs: 0, status: "OPEN" }] as any;
    s.tradeHistory = [{ id: "t", symbol: "AAA", side: "Long", entryPrice: 1, qty: 1, marginUSDT: 100, leverage: 10, openedAtMs: 0, status: "CLOSED" }] as any;
    s.savedUniverses = [{ name: "U", createdAtMs: 0, config: { minVolatilityPct: 1, minTurnoverUSDT: 1 }, symbols: ["AAA"] }] as any;
    s.currentUniverseName = "U";

    resetStore(s);

    expect(s.botRunState).toBe("STOPPED");
    expect(s.symbols.length).toBe(0);
    expect(s.openOrders.length).toBe(0);
    expect(s.openPositions.length).toBe(0);
    expect(s.tradeHistory.length).toBe(0);
    expect(s.savedUniverses.length).toBe(0);
    expect(s.currentUniverseName).toBeUndefined();
    expect(s.universeConfig.minVolatilityPct).toBe(1);
    expect(s.botConfig.leverage).toBe(10);
  });
});

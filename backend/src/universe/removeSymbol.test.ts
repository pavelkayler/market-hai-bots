import { describe, it, expect } from "vitest";
import { removeUniverseSymbol } from "./removeSymbol.js";

describe("removeUniverseSymbol (Step 14)", () => {
  it("cancels orders, closes open positions, removes from universe", () => {
    const symbols: any[] = [{ symbol: "AAA", markPrice: 10 }];
    const openOrders: any[] = [{ id:"o1", symbol:"AAA", side:"Buy", entryPrice:9, createdAtMs:0, status:"OPEN" }];
    const openPositions: any[] = [{ id:"p1", symbol:"AAA", side:"Long", entryPrice:8, qty:1, marginUSDT:100, leverage:10, openedAtMs:0, status:"OPEN" }];
    const tradeHistory: any[] = [];
    const savedUniverses: any[] = [{ name:"(1%/10M)", createdAtMs:0, config:{ minVolatilityPct:1, minTurnoverUSDT:10_000_000 }, symbols:["AAA","BBB"] }];

    removeUniverseSymbol({
      symbol: "AAA",
      symbols,
      openOrders,
      openPositions,
      tradeHistory,
      savedUniverses,
      currentUniverseName: "(1%/10M)",
    });

    expect(openOrders[0].status).toBe("CANCELLED");
    expect(openPositions[0].status).toBe("CLOSED");
    expect(tradeHistory.length).toBe(1);
    expect(symbols.length).toBe(0);
    expect(savedUniverses[0].symbols).toEqual(["BBB"]);
  });
});

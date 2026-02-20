import { describe, it, expect } from "vitest";
import { killAll } from "./killAll.js";

describe("killAll (Step 15)", () => {
  it("cancels orders and closes positions", () => {
    const now = 1000;
    const symbols: any[] = [{ symbol: "AAA", markPrice: 10 }];
    const openOrders: any[] = [{ id:"o", symbol:"AAA", side:"Buy", entryPrice:9, createdAtMs:0, status:"OPEN" }];
    const openPositions: any[] = [{ id:"p", symbol:"AAA", side:"Long", entryPrice:8, qty:1, marginUSDT:100, leverage:10, openedAtMs:0, status:"OPEN" }];
    const tradeHistory: any[] = [];
    killAll({ nowMs: now, symbols, openOrders, openPositions, tradeHistory });
    expect(openOrders[0].status).toBe("CANCELLED");
    expect(openPositions[0].status).toBe("CLOSED");
    expect(tradeHistory.length).toBe(1);
  });
});

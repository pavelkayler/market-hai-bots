import { describe, it, expect } from "vitest";
import { cancelOpenOrders } from "./orderCancel.js";

describe("order cancel on STOP (Step 10)", () => {
  it("cancels OPEN orders and resets symbol status", () => {
    const orders: any[] = [
      { id: "1", symbol: "X", side: "Buy", entryPrice: 1, createdAtMs: 0, status: "OPEN" },
      { id: "2", symbol: "X", side: "Buy", entryPrice: 1, createdAtMs: 0, status: "FILLED" },
    ];
    const symbols: any[] = [{ symbol: "X", status: "ORDER_PLACED", reason: "" }];
    cancelOpenOrders(orders as any, symbols as any);
    expect(orders[0].status).toBe("CANCELLED");
    expect(orders[1].status).toBe("FILLED");
    expect(symbols[0].status).toBe("WAITING_TRIGGER");
  });
});

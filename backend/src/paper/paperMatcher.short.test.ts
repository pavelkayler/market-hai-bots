import { describe, it, expect } from "vitest";
import { PaperMatcher } from "./paperMatcher.js";

describe("PaperMatcher SHORT + SL (Step 16)", () => {
  it("fills short order and closes on SL by ROI%", () => {
    const m = new PaperMatcher();
    const botConfig: any = { marginUSDT: 100, leverage: 10, entryOffsetPct: 1, tpRoiPct: 2, slRoiPct: 2 };
    const sym: any = { symbol:"AAA", markPrice: 100, status:"ORDER_PLACED", reason:"" };

    const orders: any[] = [{ id:"o", symbol:"AAA", side:"Sell", entryPrice: 101, createdAtMs: 0, status:"OPEN" }];
    const positions: any[] = [];
    const history: any[] = [];

    // fill short: markPrice >= entry
    sym.markPrice = 101.1;
    m.matchOrders({ nowMs: 1000, botConfig, symbol: sym, orders, positions });
    expect(positions.length).toBe(1);
    expect(sym.status).toBe("POSITION_OPEN");

    // SL for short: price goes up so pnl negative, ROI <= -2%
    const p = positions[0];
    sym.markPrice = p.entryPrice + (2 / p.qty) + 0.01;
    m.exitPositions({ nowMs: 2000, botConfig, symbol: sym, positions, tradeHistory: history });
    expect(sym.status).toBe("POSITION_CLOSED");
    expect(history.length).toBe(1);
    expect(history[0].pnlUSDT).toBeLessThan(0);
  });
});

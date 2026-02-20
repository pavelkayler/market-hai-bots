import { describe, it, expect } from "vitest";
import { createStore } from "../state/store.js";
import { makeSim } from "./simRunner.js";
import type { SymbolMetrics } from "../domain/contracts.js";

/**
 * Full-cycle test:
 * WAITING_CANDLE → WAITING_TRIGGER → AWAITING_CONFIRMATION → ORDER_PLACED → POSITION_OPEN → POSITION_CLOSED
 * then 1s cooldown back to WAITING_TRIGGER.
 *
 * Uses deterministic market points and timeframe 1m.
 */
describe("Step 10: full cycle (paper)", () => {
  it("runs full deal cycle and applies configs", () => {
    const store = createStore();

    // Set bot config explicitly (must apply)
    store.botConfig = {
      timeframe: "1m",
      priceDeltaPctThreshold: 3,
      oiDeltaPctThreshold: 10,
      fundingAbsMin: 0.01,
      minTriggersPerDay: 2,
      maxTriggersPerDay: 3,
      marginUSDT: 100,
      leverage: 10,
      entryOffsetPct: 1, // 1%
      tpRoiPct: 2,       // close at +2% ROI
      slRoiPct: 2,
    };

    store.botRunState = "RUNNING";

    const sym: SymbolMetrics = {
      symbol: "TESTUSDT",
      markPrice: 100,
      priceDeltaPct: 0,
      oiValue: 1000,
      oiDeltaPct: 0,
      fundingRate: 0.02, // LONG direction
      fundingTimeMs: 0,
      nextFundingTimeMs: Date.now() + 6 * 60_60_000,
      status: "WAITING_CANDLE",
      reason: "",
      triggerCountToday: 0,
    };

    store.symbols = [sym];
    store.tradeHistory = [];

    const sim = makeSim({ botConfig: store.botConfig, symbols: store.symbols });

    // t0 within first candle
    const t0 = 1_700_000_000_000;
    sym.markPrice = 100;
    sym.oiValue = 1000;
    sim.step(store, t0);
    expect(sym.status).toBe("WAITING_CANDLE");

    // force candle roll (t0 + 61s) with "previous close" established
    sym.markPrice = 100;
    sym.oiValue = 1000;
    sim.step(store, t0 + 61_000);
    expect(sym.status).toBe("WAITING_TRIGGER");

    // first trigger: price +5%, oi +20% vs prev candle close => awaiting confirmation
    // We need prev candle close to be 100; in this candle we set 105.
    sym.markPrice = 105;
    sym.oiValue = 1200;
    sim.step(store, t0 + 70_000); // still same 1m bucket as t0+61s candle
    expect(sym.status).toBe("AWAITING_CONFIRMATION");

    // second trigger must be in next 1m bucket (gate: 1 trigger per candle)
    sym.markPrice = 110;
    sym.oiValue = 1400;
    sim.step(store, t0 + 131_000); // next bucket => should place order
    expect(sym.status).toBe("ORDER_PLACED");
    expect(store.openOrders.length).toBe(1);

    const order = store.openOrders[0];
    // entry price should be 1% below mark (LONG)
    // order placed at markPrice*(1-0.01)
    expect(order.entryPrice).toBeCloseTo(110 * 0.99, 8);

    // Fill: set mark below entry
    sym.markPrice = order.entryPrice - 0.01;
    sim.step(store, t0 + 123_000);
    expect(store.openPositions.length).toBe(1);
    expect(sym.status).toBe("POSITION_OPEN");

    const pos = store.openPositions[0];
    // qty = (margin * leverage) / entry
    const expectedQty = (100 * 10) / pos.entryPrice;
    expect(pos.qty).toBeCloseTo(expectedQty, 8);

    // TP: need ROI >= 2% => pnl >= 2 USDT on margin 100
    // For long: pnl = (exit-entry)*qty
    // Set mark to entry + (2 / qty) + a bit
    sym.markPrice = pos.entryPrice + (2 / pos.qty) + 0.01;
    sim.step(store, t0 + 124_000);
    expect(sym.status).toBe("POSITION_CLOSED");
    expect(store.tradeHistory.length).toBe(1);

    // post-close cooldown then return to WAITING_TRIGGER after >=1s
    sim.step(store, t0 + 124_500);
    expect(sym.status).toBe("COOLDOWN");
    sim.step(store, t0 + 125_100);
    expect(sym.status).toBe("WAITING_TRIGGER");
  });
});

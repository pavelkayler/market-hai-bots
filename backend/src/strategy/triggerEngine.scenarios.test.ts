import { describe, it, expect } from "vitest";
import { TriggerEngine } from "./triggerEngine.js";

describe("TriggerEngine scenarios (Step 16)", () => {
  it("does not count triggers while bot stopped", () => {
    const eng = new TriggerEngine();
    eng.resetSymbols(["AAA"]);

    const sym: any = { symbol:"AAA", status:"WAITING_TRIGGER", reason:"", triggerCountToday:0, priceDeltaPct: 5, oiDeltaPct: 15, fundingRate: 0.02, nextFundingTimeMs: Date.now()+3600000 };
    const botConfig: any = { timeframe:"1m", priceDeltaPctThreshold: 3, oiDeltaPctThreshold: 10, fundingAbsMin: 0.01, minTriggersPerDay: 2, maxTriggersPerDay: 3, entryOffsetPct:1, marginUSDT:100, leverage:10, tpRoiPct:2, slRoiPct:2 };
    eng.step({ nowMs: 1000, botConfig, botRunning: false, symbol: sym, openOrders: [] });
    expect(sym.triggerCountToday).toBe(0);
    expect(sym.status).toBe("WAITING_TRIGGER");
  });

  it("counts 1 trigger per candle bucket (bucket gate)", () => {
    const eng = new TriggerEngine();
    eng.resetSymbols(["AAA"]);
    const sym: any = { symbol:"AAA", status:"WAITING_TRIGGER", reason:"", triggerCountToday:0, priceDeltaPct: 5, oiDeltaPct: 15, fundingRate: 0.02, nextFundingTimeMs: Date.now()+3600000 };
    const botConfig: any = { timeframe:"1m", priceDeltaPctThreshold: 3, oiDeltaPctThreshold: 10, fundingAbsMin: 0.01, minTriggersPerDay: 3, maxTriggersPerDay: 3, entryOffsetPct:1, marginUSDT:100, leverage:10, tpRoiPct:2, slRoiPct:2 };

    eng.step({ nowMs: 60_000, botConfig, botRunning: true, symbol: sym, openOrders: [] });
    eng.step({ nowMs: 61_000, botConfig, botRunning: true, symbol: sym, openOrders: [] });

    expect(sym.triggerCountToday).toBe(1);
  });

  it("enters ORDER_PLACED when reaching minTriggers and no open order yet", () => {
    const eng = new TriggerEngine();
    eng.resetSymbols(["AAA"]);
    const sym: any = { symbol:"AAA", status:"WAITING_TRIGGER", reason:"", triggerCountToday:1, priceDeltaPct: 5, oiDeltaPct: 15, fundingRate: -0.02, nextFundingTimeMs: Date.now()+3600000 };
    const botConfig: any = { timeframe:"1m", priceDeltaPctThreshold: 3, oiDeltaPctThreshold: 10, fundingAbsMin: 0.01, minTriggersPerDay: 2, maxTriggersPerDay: 3, entryOffsetPct:1, marginUSDT:100, leverage:10, tpRoiPct:2, slRoiPct:2 };

    eng.step({ nowMs: 120_000, botConfig, botRunning: true, symbol: sym, openOrders: [] });
    expect(sym.status).toBe("ORDER_PLACED");
  });
});

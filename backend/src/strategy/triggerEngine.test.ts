import { describe, it, expect } from "vitest";
import { TriggerEngine } from "./triggerEngine.js";

const baseSymbol = () => ({
  symbol: "BTCUSDT",
  markPrice: 100,
  priceDeltaPct: 5,
  oiValue: 1000,
  oiDeltaPct: 20,
  fundingRate: 0.02,
  fundingTimeMs: 0,
  nextFundingTimeMs: Date.now() + 10_000_000,
  status: "WAITING_TRIGGER" as const,
  reason: "",
  triggerCountToday: 0,
});

describe("TriggerEngine (Step 6)", () => {
  it("places order after reaching minTriggersPerDay", () => {
    const eng = new TriggerEngine();
    const s = baseSymbol();
    const cfg = {
      timeframe: "1m" as const,
      priceDeltaPctThreshold: 3,
      oiDeltaPctThreshold: 10,
      fundingAbsMin: 0.01,
      minTriggersPerDay: 2,
      maxTriggersPerDay: 3,
      marginUSDT: 100,
      leverage: 10,
      entryOffsetPct: 0.01,
      tpRoiPct: 2,
      slRoiPct: 2,
    };
    const orders: any[] = [];
    const now = Date.now();
    // first trigger => awaiting confirmation
    eng.step({ nowMs: now, botConfig: cfg, botRunning: true, symbol: s as any, openOrders: orders });
    expect(s.status).toBe("AWAITING_CONFIRMATION");
    // advance to next bucket to allow second trigger
    eng.step({ nowMs: now + 61_000, botConfig: cfg, botRunning: true, symbol: s as any, openOrders: orders });
    expect(s.status).toBe("ORDER_PLACED");
    expect(orders.length).toBe(1);
  });

  it("does nothing when bot is stopped", () => {
    const eng = new TriggerEngine();
    const s = baseSymbol();
    const cfg: any = { timeframe:"1m", priceDeltaPctThreshold:3, oiDeltaPctThreshold:10, fundingAbsMin:0.01, minTriggersPerDay:1, maxTriggersPerDay:2, marginUSDT:100, leverage:10, entryOffsetPct:0.01, tpRoiPct:2, slRoiPct:2 };
    const orders: any[] = [];
    eng.step({ nowMs: Date.now(), botConfig: cfg, botRunning: false, symbol: s as any, openOrders: orders });
    expect(orders.length).toBe(0);
  });
});

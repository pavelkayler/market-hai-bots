import { describe, it, expect } from "vitest";
import { calcQtyFromMargin, pnlFromPrices, roiPctFromPnl } from "./paperMath.js";

describe("paper math (Step 7)", () => {
  it("qty from margin", () => {
    const qty = calcQtyFromMargin({ marginUSDT: 100, leverage: 10, entryPrice: 50 });
    expect(qty).toBeCloseTo(20);
  });

  it("pnl long/short", () => {
    expect(pnlFromPrices({ side:"Long", entry:100, exit:110, qty:1 })).toBe(10);
    expect(pnlFromPrices({ side:"Short", entry:100, exit:90, qty:1 })).toBe(10);
  });

  it("roi", () => {
    expect(roiPctFromPnl({ pnlUSDT: 1, marginUSDT: 100 })).toBeCloseTo(1);
  });
});

import { feeUSDT, BYBIT_VIP0_MAKER_FEE_RATE, BYBIT_VIP0_TAKER_FEE_RATE, applyFeesToPnl } from "./paperMath.js";

describe("fees (Bybit VIP0)", () => {
  it("computes taker and maker fees on notional", () => {
    const price = 100;
    const qty = 2;
    expect(feeUSDT({ role: "TAKER", price, qty })).toBeCloseTo(price * qty * BYBIT_VIP0_TAKER_FEE_RATE, 10);
    expect(feeUSDT({ role: "MAKER", price, qty })).toBeCloseTo(price * qty * BYBIT_VIP0_MAKER_FEE_RATE, 10);
  });

  it("applies fees to pnl", () => {
    const pnl = 10;
    const out = applyFeesToPnl({ pnlUSDT: pnl, entryFeeUSDT: 1, exitFeeUSDT: 2 });
    expect(out).toBe(7);
  });
});

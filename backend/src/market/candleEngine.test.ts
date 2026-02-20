import { describe, it, expect } from "vitest";
import { CandleEngine } from "./candleEngine.js";

describe("CandleEngine (Step 5)", () => {
  it("rolls candles by timeframe", () => {
    const e = new CandleEngine("1m");
    const t0 = 1_700_000_000_000; // arbitrary
    e.push({ tsMs: t0, price: 100, oiValue: 10 });
    e.push({ tsMs: t0 + 10_000, price: 110, oiValue: 12 });
    const out = e.push({ tsMs: t0 + 61_000, price: 105, oiValue: 11 });
    expect(out.rolled).toBe(true);
    expect(out.prev.prevClose).toBe(110);
  });

  it("reset clears prev refs", () => {
    const e = new CandleEngine("1m");
    e.push({ tsMs: 0, price: 1, oiValue: 1 });
    e.push({ tsMs: 61_000, price: 2, oiValue: 2 });
    expect(e.getPrev().prevClose).toBeDefined();
    e.reset();
    expect(e.getPrev().prevClose).toBeUndefined();
  });
});

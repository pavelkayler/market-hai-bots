import { describe, it, expect } from "vitest";
import { makeInitialSymbols, tickSymbols } from "./mock/mockFeed.js";

describe("Step 1 smoke tests", () => {
  it("mock feed ticks without NaNs", () => {
    const init = makeInitialSymbols();
    const next = tickSymbols(init);
    expect(next).toHaveLength(init.length);
    for (const s of next) {
      expect(Number.isFinite(s.markPrice)).toBe(true);
      expect(Number.isFinite(s.oiValue)).toBe(true);
      expect(Number.isFinite(s.fundingRate)).toBe(true);
    }
  });
});

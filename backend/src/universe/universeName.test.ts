import { describe, it, expect } from "vitest";
import { defaultUniverseName } from "./universeName.js";

describe("defaultUniverseName (Step 16)", () => {
  it("formats (vol%/turnover) with M suffix", () => {
    expect(defaultUniverseName({ minVolatilityPct: 1, minTurnoverUSDT: 10_000_000 })).toBe("(1%/10M)");
  });

  it("formats with K suffix", () => {
    expect(defaultUniverseName({ minVolatilityPct: 2.5, minTurnoverUSDT: 55_000 })).toBe("(2.5%/55K)");
  });

  it("formats with B suffix", () => {
    expect(defaultUniverseName({ minVolatilityPct: 0.75, minTurnoverUSDT: 1_500_000_000 })).toBe("(0.75%/1.5B)");
  });
});

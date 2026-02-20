import { describe, it, expect } from "vitest";
import { Store } from "./store.js";

describe("signalRows snapshot (Step 21)", () => {
  it("returns rows only for universe symbols", () => {
    const s = new Store();
    (s as any).universe = { symbols: ["AAA"] };
    (s as any).symbols = [
      { symbol: "AAA", markPrice: 10, oiValue: 100, triggerCountToday: 2, lastSignalAtMs: 1, lastUpdateMs: 0 },
      { symbol: "BBB", markPrice: 20, oiValue: 200, triggerCountToday: 1, lastSignalAtMs: 2, lastUpdateMs: 0 },
    ] as any;

    const snap = s.snapshot();
    expect(snap.signalRows.length).toBe(1);
    expect(snap.signalRows[0].symbol).toBe("AAA");
  });
});

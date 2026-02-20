import { describe, it, expect } from "vitest";
import { BybitTickerStream } from "./tickerStream.js";

describe("BybitTickerStream.applyToSymbols (Step 16)", () => {
  it("applies latest markPrice into symbols", () => {
    const ts = new BybitTickerStream();
    // @ts-ignore private
    ts["latest"].set("AAA", { symbol: "AAA", markPrice: 123, oiValue: 10, fundingRate: 0.01, nextFundingTimeMs: 999 });
    const out = ts.applyToSymbols([{ symbol:"AAA", markPrice: 1, priceDeltaPct:0, oiValue:0, oiDeltaPct:0, fundingRate:0, fundingTimeMs:0, nextFundingTimeMs:0, status:"WAITING_TRIGGER", reason:"", triggerCountToday:0 } as any]);
    expect(out[0].markPrice).toBe(123);
  });
});

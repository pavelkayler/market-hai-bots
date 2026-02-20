import { describe, it, expect } from "vitest";
import { BybitTickerStream } from "./tickerStream.js";

describe("BybitTickerStream (Step 4) smoke", () => {
  it("constructs", () => {
    const s = new BybitTickerStream(
      { sendJson: () => false } as any,
      { info: () => {}, warn: () => {} }
    );
    expect(s).toBeTruthy();
  });
});

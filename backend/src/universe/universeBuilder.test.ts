import { describe, it, expect } from "vitest";
import { buildUniverse } from "./universeBuilder.js";
import { BybitRest } from "../bybit/bybitRest.js";

describe("Universe Builder (Step 3) smoke", () => {
  it("buildUniverse is a function", () => {
    expect(typeof buildUniverse).toBe("function");
  });

  it("BybitRest constructs", () => {
    const r = new BybitRest({ baseUrl: "https://api.bybit.com", timeoutMs: 1000 });
    expect(r).toBeTruthy();
  });
});

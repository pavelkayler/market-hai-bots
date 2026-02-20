import { describe, it, expect } from "vitest";
import { BybitWsClient } from "./bybitWsClient.js";

describe("BybitWsClient (Step 2) smoke", () => {
  it("constructs and exposes status", () => {
    const c = new BybitWsClient(
      {
        url: "ws://127.0.0.1:0",
        pingIntervalMs: 20000,
        reconnectBaseDelayMs: 10,
        reconnectMaxDelayMs: 100,
      },
      () => {},
      undefined,
      undefined
    );
    expect(c.status).toBe("DISCONNECTED");
  });
});

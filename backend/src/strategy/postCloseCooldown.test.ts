import { describe, it, expect } from "vitest";
import { shouldStayCooldown } from "./postCloseCooldown.js";

describe("post close cooldown (Step 8)", () => {
  it("stays for <1s", () => {
    expect(shouldStayCooldown(1000, 500)).toBe(true);
    expect(shouldStayCooldown(1600, 500)).toBe(false);
  });
});

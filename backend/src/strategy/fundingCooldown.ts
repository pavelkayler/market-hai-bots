/**
 * Funding cooldown window:
 * - starts 30 minutes before funding time
 * - ends 10 minutes after funding time
 *
 * Requires nextFundingTimeMs to be set for symbol.
 */
export function inFundingCooldown(nowMs: number, nextFundingTimeMs: number): boolean {
  if (!Number.isFinite(nextFundingTimeMs) || nextFundingTimeMs <= 0) return false;

  const beforeMs = 30 * 60_000;
  const afterMs = 10 * 60_000;

  const diff = nextFundingTimeMs - nowMs; // >0 means upcoming
  if (diff >= 0 && diff <= beforeMs) return true;

  const passed = nowMs - nextFundingTimeMs;
  if (passed >= 0 && passed <= afterMs) return true;

  return false;
}

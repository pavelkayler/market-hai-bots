import type { Timeframe } from "../domain/contracts.js";

export function timeframeToMs(tf: Timeframe): number {
  switch (tf) {
    case "1m": return 60_000;
    case "3m": return 3 * 60_000;
    case "5m": return 5 * 60_000;
    case "10m": return 10 * 60_000;
    case "15m": return 15 * 60_000;
    default: {
      const _exhaustive: never = tf;
      return _exhaustive;
    }
  }
}

export function bucketStartMs(tsMs: number, tf: Timeframe): number {
  const m = timeframeToMs(tf);
  return Math.floor(tsMs / m) * m;
}

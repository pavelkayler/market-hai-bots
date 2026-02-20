import type { UniverseConfig } from "../domain/contracts.js";

export function defaultUniverseName(cfg: UniverseConfig): string {
  // user example: (1%/100$) — we interpret second value as turnover threshold in USDT
  const vol = Number(cfg.minVolatilityPct).toFixed(2).replace(/\.00$/, "");
  const t = cfg.minTurnoverUSDT;
  let tStr = String(t);
  if (t >= 1_000_000_000) tStr = `${(t / 1_000_000_000).toFixed(2).replace(/\.00$/, "")}B`;
  else if (t >= 1_000_000) tStr = `${(t / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  else if (t >= 1_000) tStr = `${(t / 1_000).toFixed(2).replace(/\.00$/, "")}K`;
  return `(${vol}%/${tStr})`;
}

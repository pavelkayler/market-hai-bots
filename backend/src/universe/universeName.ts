import type { UniverseConfig } from "../domain/contracts.js";

export function defaultUniverseName(cfg: UniverseConfig): string {
  const trim = (v: number) => v.toFixed(2).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.00$/, "");
  // user example: (1%/100$) — we interpret second value as turnover threshold in USDT
  const vol = trim(Number(cfg.minVolatilityPct));
  const t = cfg.minTurnoverUSDT;
  let tStr = String(t);
  if (t >= 1_000_000_000) tStr = `${trim(t / 1_000_000_000)}B`;
  else if (t >= 1_000_000) tStr = `${trim(t / 1_000_000)}M`;
  else if (t >= 1_000) tStr = `${trim(t / 1_000)}K`;
  return `(${vol}%/${tStr})`;
}

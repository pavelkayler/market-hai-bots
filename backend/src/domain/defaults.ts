import type { BotConfig, UniverseConfig } from "./contracts.js";

export const defaultUniverseConfig: UniverseConfig = {
  minVolatilityPct: 3,
  minTurnoverUSDT: 10_000_000,
};

export const defaultBotConfig: BotConfig = {
  timeframe: "1m",

  priceDeltaPctThreshold: 3,
  oiDeltaPctThreshold: 10,
  fundingAbsMin: 0.01,

  minTriggersPerDay: 2,
  maxTriggersPerDay: 3,

  marginUSDT: 100,
  leverage: 10,
  entryOffsetPct: 0.01,

  tpRoiPct: 2,
  slRoiPct: 2,
};

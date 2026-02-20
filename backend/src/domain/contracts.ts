export * from "../../../shared/contracts.js";

export type FundingBucketRow = {
  bucket: string;
  sign: "POS" | "NEG" | "ALL";
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUSDT: number;
  netFeesUSDT: number;
  avgRoiPct: number;
  avgFundingAbs: number;
};

export type SignalRow = {
  symbol: string;
  currentPrice: number;
  lastSignalAtMs: number | null;
  signalCountToday: number;
  tradesOpenedToday: number;
  winsToday: number;
  priceChangeTodayPct: number | null;
  oiValueChangeTodayPct: number | null;
  lastUpdateAgeSec: number | null;
};

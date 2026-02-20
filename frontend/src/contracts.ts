/**
 * Shared contracts for bot state + configs.
 * Step 1 focus: define shapes and ensure both sides agree.
 */

export type Timeframe = "1m" | "3m" | "5m" | "10m" | "15m";

export type BotRunState = "RUNNING" | "STOPPED" | "KILLED";

export type SymbolStatus =
  | "WAITING_CANDLE"
  | "WAITING_TRIGGER"
  | "AWAITING_CONFIRMATION"
  | "ORDER_PLACED"
  | "POSITION_OPEN"
  | "POSITION_CLOSED"
  | "COOLDOWN";

/** Universe filters */
export interface UniverseConfig {
  minVolatilityPct: number;   // e.g. 3 (%)
  minTurnoverUSDT: number;    // e.g. 10_000_000
}

/** Strategy configuration */
export interface BotConfig {
  timeframe: Timeframe;

  priceDeltaPctThreshold: number; // % vs previous candle close
  oiDeltaPctThreshold: number;    // % vs previous OI value
  fundingAbsMin: number;          // abs(fundingRate) >=

  minTriggersPerDay: number;      // e.g. 2
  maxTriggersPerDay: number;      // e.g. 3

  // Entry block
  marginUSDT: number;             // default 100
  leverage: number;               // default 10
  entryOffsetPct: number;         // default 0.01 (%)

  // Exit as ROI% of margin
  tpRoiPct: number;               // e.g. 2
  slRoiPct: number;               // e.g. 2
}

/** Per-symbol derived metrics (display) */
export interface SymbolMetrics {
  symbol: string;

  markPrice: number;

  priceDeltaPct: number;          // vs prev candle close
  oiValue: number;                // OI value in USDT
  oiDeltaPct: number;             // vs prev oiValue

  fundingRate: number;            // signed
  fundingTimeMs: number;          // last funding publish time (ms since epoch)
  nextFundingTimeMs: number;      // next funding time (ms since epoch)

  status: SymbolStatus;
  reason: string;

  // Counters (daily)
  triggerCountToday: number;
  lastSignalAtMs?: number | null;
}

/** Paper order */
export interface PaperOrder {
  id: string;
  symbol: string;
  side: "Buy" | "Sell";
  entryPrice: number;
  createdAtMs: number;
  status: "OPEN" | "FILLED" | "CANCELLED";
}

/** Paper position */
export interface PaperPosition {
  isRecorded?: boolean;
  id: string;
  symbol: string;
  side: "Long" | "Short";
  entryPrice: number;
  qty: number;
  marginUSDT: number;
  leverage: number;
  openedAtMs: number;
  status: "OPEN" | "CLOSED";
  exitPrice?: number;
  closedAtMs?: number;
  pnlUSDT?: number;
  pnlRoiPct?: number;
  entryFeeUSDT?: number;
  exitFeeUSDT?: number;
  fundingRateAtEntry?: number;
  fundingAbsAtEntry?: number;
  nextFundingTimeMsAtEntry?: number;
}

/** Snapshot broadcasted from backend to frontend */
export interface TradeResultRow {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUSDT: number;
  netRoiPct: number;
  avgRoiPct: number;
}

export interface BotSnapshot {
  serverTimeMs: number;

  connections: {
    frontendToBackend: "CONNECTED" | "DISCONNECTED"; // from FE perspective
    backendToBybit: "CONNECTED" | "DISCONNECTED";    // actual Bybit WS
  };

  botRunState: BotRunState;

  universe: {
    totalSymbols: number;
    selectedSymbols: number;
  };

  configs: {
    universeConfig: UniverseConfig;
    botConfig: BotConfig;
  };

  symbols: SymbolMetrics[];

  openOrders: PaperOrder[];
  openPositions: PaperPosition[];
// Closed trades (paper)
tradeHistory: PaperPosition[];
// Aggregated per-symbol results
tradeResults: TradeResultRow[];
savedUniverses: UniversePreset[];
currentUniverseName?: string;
}

/** WS client->server messages */
export type ClientMessage =
  | { type: "PING"; clientTimeMs: number }
  | { type: "REFRESH_SNAPSHOT" }
  | { type: "REFRESH_SIGNALS" }
  | { type: "SET_BOT_RUN_STATE"; state: BotRunState }
  | { type: "SET_UNIVERSE_CONFIG"; config: UniverseConfig }
  | { type: "REBUILD_UNIVERSE" };

/** WS server->client messages */
export type ServerMessage =
  | { type: "PONG"; serverTimeMs: number; clientTimeMs: number }
  | { type: "SNAPSHOT"; snapshot: BotSnapshot }
  | { type: "ACK"; ok: true; requestType: ClientMessage["type"] }
  | { type: "ERROR"; ok: false; message: string; requestType?: string };

export type FundingBucketRow = {
  bucket: string; // e.g. "0.005%-0.010%"
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


export const defaultUniverseConfig = {
  minVolatilityPct: 3,
  minTurnoverUSDT: 10_000_000,
};

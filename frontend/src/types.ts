export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BothTieBreak = 'shortPriority' | 'longPriority' | 'strongerSignal';
export type BotTf = 1 | 3 | 5;
export type StrategyMode = 'IMPULSE' | 'PUMP_DUMP_2ND_TRIGGER';
export type AutoTuneScope = 'GLOBAL' | 'UNIVERSE_ONLY';
export type EntryReason = 'LONG_CONTINUATION' | 'SHORT_CONTINUATION' | 'SHORT_DIVERGENCE';

export type BotSettings = {
  mode: BotMode;
  direction: BotDirection;
  bothTieBreak: BothTieBreak;
  tf: BotTf;
  strategyMode: StrategyMode;
  /** @deprecated confirmation now uses signalCounterThreshold */
  holdSeconds: number;
  signalCounterThreshold: number;
  signalCounterMin: number;
  signalCounterMax: number;
  priceUpThrPct: number;
  oiUpThrPct: number;
  oiCandleThrPct: number;
  marginUSDT: number;
  leverage: number;
  tpRoiPct: number;
  slRoiPct: number;
  entryOffsetPct: number;
  maxActiveSymbols: number;
  dailyLossLimitUSDT: number;
  maxConsecutiveLosses: number;
  trendTfMinutes: 5 | 15;
  trendLookbackBars: number;
  trendMinMovePct: number;
  confirmWindowBars: number;
  confirmMinContinuationPct: number;
  impulseMaxAgeBars: number;
  requireOiTwoCandles: boolean;
  maxSecondsIntoCandle: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  maxTickStalenessMs: number;
  minNotionalUSDT: number;
  autoTuneEnabled: boolean;
  autoTuneScope: AutoTuneScope;
  paperEntrySlippageBps?: number;
  paperExitSlippageBps?: number;
  paperPartialFillPct?: number;
};

export type BotConfig = BotSettings;

export type ProfilesState = {
  ok: true;
  activeProfile: string;
  names: string[];
};

export type BotState = {
  running: boolean;
  paused: boolean;
  pauseReason?: string | null;
  hasSnapshot: boolean;
  lastConfig: BotConfig | null;
  mode: BotMode | null;
  direction: BotDirection | null;
  tf: BotTf | null;
  queueDepth: number;
  activeOrders: number;
  openPositions: number;
  symbolUpdatesPerSec?: number;
  journalAgeMs?: number;
  openOrders?: Array<{
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: number;
    limitPrice: number;
    status: string;
    orderId: string | null;
    orderLinkId: string | null;
  }>;
  positions?: Array<{
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    avgPrice: number;
    unrealizedPnl: number;
  }>;
  startedAt?: number | null;
  uptimeMs: number;
  killInProgress?: boolean;
  killCompletedAt?: number | null;
  killWarning?: string | null;
  activeSymbolDiagnostics?: Array<{
    symbol: string;
    signalCount24h: number;
    signalCounterThreshold: number;
    signalConfirmed: boolean;
    lastSignalAt?: number;
  }>;
};


export type BotStatsSideBreakdown = {
  trades: number;
  wins: number;
  losses: number;
  winratePct: number;
  pnlUSDT: number;
};


export type BotPerSymbolStats = {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winratePct: number;
  pnlUSDT: number;
  longTrades: number;
  longWins: number;
  longLosses: number;
  shortTrades: number;
  shortWins: number;
  shortLosses: number;
  signalsAttempted: number;
  signalsConfirmed: number;
  confirmedBySide: { long: number; short: number };
  confirmedByEntryReason: Record<EntryReason, number>;
  avgHoldMs?: number | null;
  lastClosedTs?: number | null;
  lastClosedPnlUSDT?: number | null;
};

export type BotStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  winratePct: number;
  pnlUSDT: number;
  avgWinUSDT: number | null;
  avgLossUSDT: number | null;
  lossStreak: number;
  todayPnlUSDT: number;
  guardrailPauseReason: string | null;
  long: BotStatsSideBreakdown;
  short: BotStatsSideBreakdown;
  reasonCounts: Record<EntryReason, number>;
  signalsConfirmed: number;
  signalsBySide: { long: number; short: number };
  signalsByEntryReason: Record<EntryReason, number>;
  bothHadBothCount: number;
  bothChosenLongCount: number;
  bothChosenShortCount: number;
  bothTieBreakMode: BothTieBreak;
  totalFeesUSDT: number;
  totalSlippageUSDT: number;
  avgSpreadBpsEntry: number | null;
  avgSpreadBpsExit: number | null;
  expectancyUSDT: number | null;
  profitFactor: number | null;
  avgFeePerTradeUSDT: number | null;
  avgNetPerTradeUSDT: number | null;
  lastClosed?: {
    ts: number;
    symbol: string;
    side: 'LONG' | 'SHORT';
    grossPnlUSDT: number;
    feesUSDT: number;
    netPnlUSDT: number;
    slippageUSDT: number | null;
    entry?: {
      markAtSignal?: number;
      entryLimit?: number;
      fillPrice?: number;
      entryOffsetPct?: number;
      slippageBpsApplied?: number;
      spreadBpsAtEntry?: number | null;
    };
    exit?: {
      tpPrice?: number;
      slPrice?: number;
      closePrice?: number;
      slippageBpsApplied?: number;
      spreadBpsAtExit?: number | null;
    };
    impact?: {
      grossPnlUSDT?: number;
      feesUSDT?: number;
      slippageUSDT?: number | null;
      netPnlUSDT?: number;
    };
    entryFeeUSDT?: number;
    exitFeeUSDT?: number;
    reason: string;
  };
  perSymbol?: BotPerSymbolStats[];
};

export type UniverseFilters = {
  minTurnover: number;
  minVolPct: number;
};

export type UniverseEntry = {
  symbol: string;
  turnover24hUSDT: number;
  turnover24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  vol24hRangePct: number;
  vol24hPct: number;
  forcedActive: boolean;
};

export type UniverseState = {
  ok: boolean;
  ready: boolean;
  createdAt?: number;
  filters?: UniverseFilters;
  symbols?: UniverseEntry[];
  metricDefinition?: string;
  contractFilter?: 'USDT_LINEAR_PERPETUAL_ONLY';
  filteredOut?: {
    expiringOrNonPerp: number;
    byMetricThreshold?: number;
    dataUnavailable?: number;
  };
  diagnostics?: {
    totals: {
      instrumentsTotal: number;
      tickersTotal: number;
      matchedTotal: number;
      validTotal: number;
    };
    excluded: {
      nonPerp: number;
      expiring: number;
      nonLinear: number;
      nonTrading: number;
      nonUSDT: number;
      tickerMissing: number;
      thresholdFiltered: number;
      parseError: number;
      unknown: number;
    };
  };
  notReadyReason?: string;
  excluded?: string[];
  upstreamStatus?: 'ok' | 'error';
  upstreamError?: {
    code: 'BYBIT_UNREACHABLE' | 'TIMEOUT' | 'BYBIT_AUTH_ERROR' | 'BYBIT_BAD_RESPONSE' | 'PARSE_ERROR' | 'UPSTREAM_RATE_LIMIT';
    message: string;
    hint: string;
    retryable: boolean;
  };
  lastKnownUniverseAvailable?: boolean;
};

export type SymbolBaseline = {
  basePrice: number;
  baseOiValue: number;
  baseTs: number;
};

export type PendingOrder = {
  symbol: string;
  side: 'Buy' | 'Sell';
  limitPrice: number;
  qty: number;
  placedTs?: number;
  createdTs?: number;
  expiresTs: number;
  tpPrice?: number;
  slPrice?: number;
  sentToExchange?: boolean;
};

export type Position = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  qty: number;
  tpPrice: number;
  slPrice: number;
  openedTs: number;
  closeReason?: string;
  exitPrice?: number;
  realizedGrossPnlUSDT?: number;
  feesUSDT?: number;
  realizedNetPnlUSDT?: number;
  entryFeeUSDT?: number;
  exitFeeUSDT?: number;
  entryFeeRate?: number;
  exitFeeRate?: number;
  lastPnlUSDT?: number;
};

export type NoEntryReason = {
  code: string;
  message: string;
  value?: number;
  threshold?: number;
};


export type BothCandidateDiagnostics = {
  hadBoth: boolean;
  chosen: 'long' | 'short';
  tieBreak: BothTieBreak;
  edgeLong?: number;
  edgeShort?: number;
};

export type GateSnapshot = {
  tf: number;
  higherTfMinutes: number;
  trendDir: 'up' | 'down' | 'flat' | null;
  trendBlocked: boolean;
  trendBlockReason?: string;
  confirmWindowBars: number;
  confirmCount: number;
  confirmZ?: number | null;
  oiCandleValue?: number | null;
  oiPrevCandleValue?: number | null;
  oiCandleDeltaPct?: number | null;
  continuationOk?: boolean | null;
  impulseAgeMs?: number | null;
  spreadBps?: number | null;
  tickAgeMs?: number | null;
  bothCandidate?: BothCandidateDiagnostics;
};

export type SymbolUpdatePayload = {
  symbol: string;
  state: 'IDLE' | 'HOLDING_LONG' | 'HOLDING_SHORT' | 'ARMED_LONG' | 'ARMED_SHORT' | 'ENTRY_PENDING' | 'POSITION_OPEN';
  markPrice: number;
  openInterestValue: number;
  oiCandleValue: number | null;
  oiPrevCandleValue: number | null;
  oiCandleDeltaValue: number | null;
  oiCandleDeltaPct: number | null;
  baseline: SymbolBaseline | null;
  pendingOrder: PendingOrder | null;
  position: Position | null;
  topReasons?: NoEntryReason[];
  entryReason?: EntryReason | null;
  priceDeltaPct?: number | null;
  oiDeltaPct?: number | null;
  signalCount24h?: number;
  signalCounterThreshold?: number;
  signalCounterMin?: number;
  signalCounterMax?: number;
  signalCounterEligible?: boolean;
  signalConfirmed?: boolean;
  lastSignalAt?: number;
  gates?: GateSnapshot | null;
  bothCandidate?: BothCandidateDiagnostics | null;
};

export type QueueUpdatePayload = {
  depth: number;
};

export type SymbolsUpdatePayload = {
  updates: SymbolUpdatePayload[];
};

export type ReplaySpeed = '1x' | '5x' | '20x' | 'fast';

export type ReplayState = {
  recording: boolean;
  replaying: boolean;
  fileName: string | null;
  speed: ReplaySpeed | null;
  recordsWritten: number;
  progress: {
    read: number;
    total: number;
  };
};

export type JournalEntry = {
  ts: number;
  mode: 'paper' | 'demo';
  symbol: string;
  event:
    | 'SIGNAL'
    | 'ORDER_PLACED'
    | 'ORDER_FILLED'
    | 'ORDER_CANCELLED'
    | 'ORDER_EXPIRED'
    | 'POSITION_OPENED'
    | 'POSITION_CLOSED'
    | 'BOT_PAUSE'
    | 'BOT_RESUME'
    | 'BOT_KILL'
    | 'SYSTEM_RESET_ALL'
    | 'EXPORT_PACK_REQUESTED';
  side: 'LONG' | 'SHORT' | null;
  data: Record<string, unknown>;
};

export type WsEnvelope<T = unknown> = {
  type: string;
  ts: number;
  payload: T;
};

export type DoctorResponse = {
  ok: true;
  serverTime: number;
  uptimeSec: number;
  version: string;
  universe: { ready: boolean; symbols: number };
  market: {
    running: boolean;
    subscribed: number;
    updatesPerSec: number;
    tickHandlersMsAvg: number;
    wsClients: number;
    wsFramesPerSec: number;
  };
  bot: {
    running: boolean;
    paused: boolean;
    mode: BotMode | null;
    tf: BotTf | null;
    direction: BotDirection | null;
    evalsPerSec: number;
  };
  replay: { recording: boolean; replaying: boolean; fileName: string | null };
  journal: { enabled: true; path: string; sizeBytes: number };
  demo: { configured: boolean };
};

export type AutoTuneRuntimeState = {
  enabled: boolean;
  scope: AutoTuneScope;
  lastApplied: { ts: number; parameter: string; before: number; after: number; reason: string } | null;
};

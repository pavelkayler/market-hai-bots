export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BotTf = 1 | 3 | 5;

export type BotSettings = {
  mode: BotMode;
  direction: BotDirection;
  tf: BotTf;
  holdSeconds: number;
  priceUpThrPct: number;
  oiUpThrPct: number;
  marginUSDT: number;
  leverage: number;
  tpRoiPct: number;
  slRoiPct: number;
  maxActiveSymbols: number;
  dailyLossLimitUSDT: number;
  maxConsecutiveLosses: number;
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
  hasSnapshot: boolean;
  lastConfig: BotConfig | null;
  mode: BotMode | null;
  direction: BotDirection | null;
  tf: BotTf | null;
  queueDepth: number;
  activeOrders: number;
  openPositions: number;
  startedAt?: number | null;
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
  lastClosed?: {
    ts: number;
    symbol: string;
    pnlUSDT: number;
  };
};

export type UniverseFilters = {
  minTurnover: number;
  minVolPct: number;
};

export type UniverseEntry = {
  symbol: string;
  turnover24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  vol24hPct: number;
  forcedActive: boolean;
};

export type UniverseState = {
  ok: boolean;
  ready: boolean;
  createdAt?: number;
  filters?: UniverseFilters;
  symbols?: UniverseEntry[];
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
  createdTs: number;
  expiresTs: number;
};

export type Position = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  qty: number;
  tpPrice: number;
  slPrice: number;
  openedTs: number;
  lastPnlUSDT?: number;
};

export type SymbolUpdatePayload = {
  symbol: string;
  state: 'IDLE' | 'HOLDING_LONG' | 'HOLDING_SHORT' | 'ENTRY_PENDING' | 'POSITION_OPEN';
  markPrice: number;
  openInterestValue: number;
  baseline: SymbolBaseline | null;
  pendingOrder: PendingOrder | null;
  position: Position | null;
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
    | 'BOT_KILL';
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

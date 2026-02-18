import type { DemoClosedPnlItem, DemoOpenOrder, DemoPosition, IDemoTradeClient } from '../bybit/demoTradeClient.js';
import type { MarketState } from '../market/marketHub.js';
import { DemoOrderQueue, type DemoQueueSnapshot } from './demoOrderQueue.js';
import { PAPER_FEES } from './paperFees.js';
import type { PaperPendingOrder, PaperPosition } from './paperTypes.js';
import type { RuntimeSnapshot, RuntimeSnapshotSymbol, SnapshotStore } from './snapshotStore.js';
import type { UniverseEntry } from '../types/universe.js';
import { normalizeQty } from '../utils/qty.js';
import { percentToFraction } from '../utils/percent.js';
import { computePnlBreakdown } from '../utils/pnlMath.js';

export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BothTieBreak = 'shortPriority' | 'longPriority' | 'strongerSignal';
export type BotTf = 1 | 3 | 5;
export type StrategyMode = 'IMPULSE' | 'PUMP_DUMP_2ND_TRIGGER';
export type AutoTuneScope = 'GLOBAL' | 'UNIVERSE_ONLY';

export type BotConfig = {
  mode: BotMode;
  direction: BotDirection;
  bothTieBreak: BothTieBreak;
  tf: BotTf;
  strategyMode: StrategyMode;
  /** @deprecated confirmation now uses signalCounterThreshold */
  holdSeconds: number;
  /** @deprecated maps to signalCounterMin=threshold, signalCounterMax=Infinity */
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
  autoTunePlannerMode?: 'DETERMINISTIC' | 'RANDOM_EXPLORE';
  paperEntrySlippageBps?: number;
  paperExitSlippageBps?: number;
  paperPartialFillPct?: number;
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
  bothCandidate?: {
    hadBoth: boolean;
    chosen: 'long' | 'short';
    tieBreak: BothTieBreak;
    edgeLong?: number;
    edgeShort?: number;
  };
};

export type BothCandidateDiagnostics = {
  hadBoth: boolean;
  chosen: 'long' | 'short';
  tieBreak: BothTieBreak;
  edgeLong?: number;
  edgeShort?: number;
};

export type BotState = {
  running: boolean;
  paused: boolean;
  hasSnapshot: boolean;
  startedAt: number | null;
  runningSinceTs: number | null;
  activeUptimeMs: number;
  uptimeMs: number;
  config: BotConfig | null;
  queueDepth: number;
  activeOrders: number;
  openPositions: number;
};

export type KillSwitchResult = {
  cancelledOrders: number;
  closedPositions: number;
  warning: string | null;
  activeOrdersRemaining: number;
  openPositionsRemaining: number;
};

type BotStatsSideBreakdown = {
  trades: number;
  wins: number;
  losses: number;
  winratePct: number;
  pnlUSDT: number;
};

export type SymbolFsmState = 'IDLE' | 'HOLDING_LONG' | 'HOLDING_SHORT' | 'ARMED_LONG' | 'ARMED_SHORT' | 'ENTRY_PENDING' | 'POSITION_OPEN';

export type NoEntryReason = {
  code:
    | 'TREND_BLOCK_LONG'
    | 'TREND_BLOCK_SHORT'
    | 'OI_CANDLE_GATE_FAIL'
    | 'OI_2CANDLES_FAIL'
    | 'SIGNAL_COUNTER_NOT_MET'
    | 'SIGNAL_COUNTER_OUT_OF_RANGE'
    | 'NO_CONTINUATION'
    | 'IMPULSE_STALE'
    | 'IMPULSE_TOO_LATE'
    | 'QTY_BELOW_MIN'
    | 'NOTIONAL_TOO_SMALL'
    | 'MAX_ACTIVE_REACHED'
    | 'GUARDRAIL_PAUSED'
    | 'SPREAD_TOO_WIDE'
    | 'NO_BIDASK'
    | 'TICK_STALE'
    | 'INVALID_ENTRY_PAYLOAD'
    | 'INVALID_DEMO_ORDER_PAYLOAD';
  message: string;
  value?: number;
  threshold?: number;
};

export type EntryReason = 'LONG_CONTINUATION' | 'SHORT_CONTINUATION' | 'SHORT_DIVERGENCE';
export type TradeCloseReason = 'TP' | 'SL' | 'KILL' | 'MANUAL';

export type SymbolBaseline = {
  basePrice: number;
  baseOiValue: number;
  baseTs: number;
};

export type DemoRuntimeState = {
  orderId: string | null;
  orderLinkId: string | null;
  placedTs: number;
  expiresTs: number;
};

export type SymbolRuntimeState = {
  symbol: string;
  fsmState: SymbolFsmState;
  baseline: SymbolBaseline | null;
  holdStartTs: number | null;
  signalEvents: number[];
  lastSignalBucketKey: number | null;
  signalEvents24h: number[];
  lastSignalBucketStart: number | null;
  prevCandleOi: number | null;
  lastCandleOi: number | null;
  prevCandleMark: number | null;
  lastCandleMark: number | null;
  lastCandleBucketStart: number | null;
  lastEvaluationGateTs: number | null;
  blockedUntilTs: number;
  overrideGateOnce: boolean;
  pendingOrder: PaperPendingOrder | null;
  position: PaperPosition | null;
  demo: DemoRuntimeState | null;
  trendCandles5m: TrendCandle[];
  trendCandles15m: TrendCandle[];
  oiCandleDeltaPctHistory: number[];
  armedSignal: {
    side: 'LONG' | 'SHORT';
    triggerMark: number;
    triggerBucketStart: number;
    continuationWindowEndBucketStart: number;
  } | null;
  noEntryReasonCounts: Map<NoEntryReason['code'], number>;
  lastNoEntryReasons: NoEntryReason[];
  entryReason: EntryReason | null;
  lastPriceDeltaPct: number | null;
  lastOiDeltaPct: number | null;
  lastSignalCount24h: number;
  gates: GateSnapshot | null;
  lastBothCandidate: BothCandidateDiagnostics | null;
};

export type SignalPayload = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  markPrice: number;
  oiValue: number;
  priceDeltaPct: number;
  oiDeltaPct: number;
  entryReason: EntryReason;
  bothCandidate?: BothCandidateDiagnostics;
};

export type OrderUpdatePayload = {
  symbol: string;
  status: 'PLACED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
  order: PaperPendingOrder;
};

export type PositionUpdatePayload = {
  symbol: string;
  status: 'OPEN' | 'CLOSED';
  position: PaperPosition;
  exitPrice?: number;
  pnlUSDT?: number;
  closeReason?: string;
  realizedGrossPnlUSDT?: number;
  feesUSDT?: number;
  realizedNetPnlUSDT?: number;
  entryFeeUSDT?: number;
  exitFeeUSDT?: number;
  entryFeeRate?: number;
  exitFeeRate?: number;
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
    entry?: PositionUpdatePayload['entry'];
    exit?: PositionUpdatePayload['exit'];
    impact?: PositionUpdatePayload['impact'];
    entryFeeUSDT?: number;
    exitFeeUSDT?: number;
    reason: string;
    pnlUSDT?: number;
  };
  perSymbol?: BotPerSymbolStats[];
};

type BotPerSymbolAccumulator = {
  trades: number;
  wins: number;
  losses: number;
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
  totalHoldMs: number;
  closedTradesWithHold: number;
  lastClosedTs: number | null;
  lastClosedPnlUSDT: number | null;
};

type TrendCandle = {
  bucketStart: number;
  openTs: number;
  closeTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
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

type BotEngineDeps = {
  now?: () => number;
  emitSignal: (payload: SignalPayload) => void;
  emitOrderUpdate: (payload: OrderUpdatePayload) => void;
  emitPositionUpdate: (payload: PositionUpdatePayload) => void;
  emitQueueUpdate: (payload: DemoQueueSnapshot) => void;
  demoTradeClient?: IDemoTradeClient;
  snapshotStore?: SnapshotStore;
  emitLog?: (message: string) => void;
  onGuardrailPaused?: (payload: { reason: string; stats: BotStats; state: BotState }) => void;
};

const DEFAULT_HOLD_SECONDS = 3;
const DEFAULT_SIGNAL_COUNTER_THRESHOLD = 2;
const DEFAULT_STRATEGY_MODE: StrategyMode = 'IMPULSE';
const DEFAULT_SIGNAL_COUNTER_MIN = DEFAULT_SIGNAL_COUNTER_THRESHOLD;
const DEFAULT_SIGNAL_COUNTER_MAX = Number.MAX_SAFE_INTEGER;
const DEFAULT_AUTO_TUNE_ENABLED = false;
const DEFAULT_AUTO_TUNE_SCOPE: AutoTuneScope = 'GLOBAL';
const DEFAULT_AUTO_TUNE_PLANNER_MODE: 'DETERMINISTIC' | 'RANDOM_EXPLORE' = 'DETERMINISTIC';
const DEFAULT_OI_UP_THR_PCT = 50;
const DEFAULT_OI_CANDLE_THR_PCT = 0;
const DEFAULT_MAX_ACTIVE_SYMBOLS = 3;
const DEFAULT_ENTRY_OFFSET_PCT = 0.01;
const DEFAULT_BOTH_TIE_BREAK: BothTieBreak = 'shortPriority';
const DEFAULT_TREND_TF: 5 | 15 = 5;
const DEFAULT_TREND_LOOKBACK_BARS = 20;
const DEFAULT_TREND_MIN_MOVE_PCT = 0.2;
const DEFAULT_CONFIRM_WINDOW_BARS = 2;
const DEFAULT_CONFIRM_MIN_CONTINUATION_PCT = 0;
const DEFAULT_IMPULSE_MAX_AGE_BARS = 2;
const DEFAULT_REQUIRE_OI_TWO_CANDLES = false;
const DEFAULT_MAX_SECONDS_INTO_CANDLE = 45;
const DEFAULT_MIN_SPREAD_BPS = 0;
const DEFAULT_MAX_SPREAD_BPS = 0;
const DEFAULT_MAX_TICK_STALENESS_MS = 0;
const DEFAULT_MIN_NOTIONAL_USDT = 5;
const DEFAULT_PAPER_ENTRY_SLIPPAGE_BPS = 0;
const DEFAULT_PAPER_EXIT_SLIPPAGE_BPS = 0;
const DEFAULT_PAPER_PARTIAL_FILL_PCT = 100;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const PNL_SANITY_WINDOW_TRADES = 20;
const NO_ENTRY_REASON_CODES: NoEntryReason['code'][] = [
  'TREND_BLOCK_LONG',
  'TREND_BLOCK_SHORT',
  'OI_CANDLE_GATE_FAIL',
  'OI_2CANDLES_FAIL',
  'SIGNAL_COUNTER_NOT_MET',
  'SIGNAL_COUNTER_OUT_OF_RANGE',
  'NO_CONTINUATION',
  'IMPULSE_STALE',
  'IMPULSE_TOO_LATE',
  'QTY_BELOW_MIN',
  'NOTIONAL_TOO_SMALL',
  'MAX_ACTIVE_REACHED',
  'GUARDRAIL_PAUSED',
  'SPREAD_TOO_WIDE',
  'NO_BIDASK',
  'TICK_STALE'
];

const createEmptySideBreakdown = (): BotStatsSideBreakdown => ({
  trades: 0,
  wins: 0,
  losses: 0,
  winratePct: 0,
  pnlUSDT: 0
});

const createEmptyReasonCounts = (): Record<EntryReason, number> => ({
  LONG_CONTINUATION: 0,
  SHORT_CONTINUATION: 0,
  SHORT_DIVERGENCE: 0
});

export const normalizeBotConfig = (raw: Record<string, unknown>): BotConfig | null => {
  const tf = raw.tf;
  const mode = raw.mode;
  const direction = raw.direction;
  const bothTieBreakRaw = raw.bothTieBreak;

  if (mode !== 'paper' && mode !== 'demo') {
    return null;
  }

  if (direction !== 'long' && direction !== 'short' && direction !== 'both') {
    return null;
  }

  const bothTieBreak: BothTieBreak =
    bothTieBreakRaw === 'longPriority' || bothTieBreakRaw === 'strongerSignal' || bothTieBreakRaw === 'shortPriority'
      ? bothTieBreakRaw
      : DEFAULT_BOTH_TIE_BREAK;

  if (tf !== 1 && tf !== 3 && tf !== 5) {
    return null;
  }

  const holdSeconds = typeof raw.holdSeconds === 'number' && Number.isFinite(raw.holdSeconds) ? raw.holdSeconds : DEFAULT_HOLD_SECONDS;
  const strategyMode = raw.strategyMode === 'PUMP_DUMP_2ND_TRIGGER' || raw.strategyMode === 'IMPULSE' ? raw.strategyMode : DEFAULT_STRATEGY_MODE;
  const signalCounterThreshold =
    typeof raw.signalCounterThreshold === 'number' && Number.isFinite(raw.signalCounterThreshold)
      ? Math.max(1, Math.floor(raw.signalCounterThreshold))
      : DEFAULT_SIGNAL_COUNTER_THRESHOLD;
  const signalCounterMinRaw = typeof raw.signalCounterMin === 'number' && Number.isFinite(raw.signalCounterMin) ? raw.signalCounterMin : signalCounterThreshold;
  const signalCounterMaxRaw =
    typeof raw.signalCounterMax === 'number' && Number.isFinite(raw.signalCounterMax) ? raw.signalCounterMax : Number.MAX_SAFE_INTEGER;
  const signalCounterMin = Math.max(1, Math.floor(signalCounterMinRaw));
  const signalCounterMax = Math.max(signalCounterMin, Math.floor(signalCounterMaxRaw));
  const oiUpThrPct = typeof raw.oiUpThrPct === 'number' && Number.isFinite(raw.oiUpThrPct) ? raw.oiUpThrPct : DEFAULT_OI_UP_THR_PCT;
  const oiCandleThrPct =
    typeof raw.oiCandleThrPct === 'number' && Number.isFinite(raw.oiCandleThrPct) ? Math.max(0, raw.oiCandleThrPct) : DEFAULT_OI_CANDLE_THR_PCT;
  const maxActiveSymbols =
    typeof raw.maxActiveSymbols === 'number' && Number.isFinite(raw.maxActiveSymbols) ? Math.max(1, Math.floor(raw.maxActiveSymbols)) : DEFAULT_MAX_ACTIVE_SYMBOLS;
  const dailyLossLimitUSDT =
    typeof raw.dailyLossLimitUSDT === 'number' && Number.isFinite(raw.dailyLossLimitUSDT) ? Math.max(0, raw.dailyLossLimitUSDT) : 0;
  const maxConsecutiveLosses =
    typeof raw.maxConsecutiveLosses === 'number' && Number.isFinite(raw.maxConsecutiveLosses)
      ? Math.max(0, Math.floor(raw.maxConsecutiveLosses))
      : 0;
  const entryOffsetPct =
    typeof raw.entryOffsetPct === 'number' && Number.isFinite(raw.entryOffsetPct) ? Math.max(0, raw.entryOffsetPct) : DEFAULT_ENTRY_OFFSET_PCT;
  const trendTfMinutes = raw.trendTfMinutes === 15 || raw.trendTf === 15 ? 15 : DEFAULT_TREND_TF;
  const trendLookbackBarsRaw = typeof raw.trendLookbackBars === 'number' ? raw.trendLookbackBars : DEFAULT_TREND_LOOKBACK_BARS;
  const trendLookbackBars = Math.max(10, Math.min(200, Math.floor(trendLookbackBarsRaw)));
  const trendMinMovePctRaw = typeof raw.trendMinMovePct === 'number' ? raw.trendMinMovePct : raw.trendThrPct;
  const trendMinMovePct = typeof trendMinMovePctRaw === 'number' && Number.isFinite(trendMinMovePctRaw) ? Math.max(0, trendMinMovePctRaw) : DEFAULT_TREND_MIN_MOVE_PCT;
  const confirmWindowBarsRaw = typeof raw.confirmWindowBars === 'number' ? raw.confirmWindowBars : raw.confirmMaxCandles;
  const confirmWindowBars =
    typeof confirmWindowBarsRaw === 'number' && Number.isFinite(confirmWindowBarsRaw)
      ? Math.max(1, Math.min(5, Math.floor(confirmWindowBarsRaw)))
      : DEFAULT_CONFIRM_WINDOW_BARS;
  const confirmMinContinuationPctRaw = typeof raw.confirmMinContinuationPct === 'number' ? raw.confirmMinContinuationPct : raw.confirmMovePct;
  const confirmMinContinuationPct =
    typeof confirmMinContinuationPctRaw === 'number' && Number.isFinite(confirmMinContinuationPctRaw)
      ? Math.max(0, confirmMinContinuationPctRaw)
      : DEFAULT_CONFIRM_MIN_CONTINUATION_PCT;
  const impulseMaxAgeBars =
    typeof raw.impulseMaxAgeBars === 'number' && Number.isFinite(raw.impulseMaxAgeBars)
      ? Math.max(1, Math.min(10, Math.floor(raw.impulseMaxAgeBars)))
      : DEFAULT_IMPULSE_MAX_AGE_BARS;
  const requireOiTwoCandles = typeof raw.requireOiTwoCandles === 'boolean' ? raw.requireOiTwoCandles : DEFAULT_REQUIRE_OI_TWO_CANDLES;
  const maxSecondsIntoCandle =
    typeof raw.maxSecondsIntoCandle === 'number' && Number.isFinite(raw.maxSecondsIntoCandle)
      ? Math.max(0, Math.floor(raw.maxSecondsIntoCandle))
      : DEFAULT_MAX_SECONDS_INTO_CANDLE;
  const minSpreadBps = typeof raw.minSpreadBps === 'number' && Number.isFinite(raw.minSpreadBps) ? Math.max(0, raw.minSpreadBps) : DEFAULT_MIN_SPREAD_BPS;
  const maxSpreadBps = typeof raw.maxSpreadBps === 'number' && Number.isFinite(raw.maxSpreadBps) ? Math.max(0, raw.maxSpreadBps) : DEFAULT_MAX_SPREAD_BPS;
  const maxTickStalenessMs =
    typeof raw.maxTickStalenessMs === 'number' && Number.isFinite(raw.maxTickStalenessMs)
      ? Math.max(0, Math.floor(raw.maxTickStalenessMs))
      : DEFAULT_MAX_TICK_STALENESS_MS;
  const minNotionalUSDT =
    typeof raw.minNotionalUSDT === 'number' && Number.isFinite(raw.minNotionalUSDT) ? Math.max(0, raw.minNotionalUSDT) : DEFAULT_MIN_NOTIONAL_USDT;
  const autoTuneEnabled = typeof raw.autoTuneEnabled === 'boolean' ? raw.autoTuneEnabled : DEFAULT_AUTO_TUNE_ENABLED;
  const autoTuneScope = raw.autoTuneScope === 'UNIVERSE_ONLY' || raw.autoTuneScope === 'GLOBAL' ? raw.autoTuneScope : DEFAULT_AUTO_TUNE_SCOPE;
  const autoTunePlannerMode = raw.autoTunePlannerMode === 'RANDOM_EXPLORE' ? 'RANDOM_EXPLORE' : DEFAULT_AUTO_TUNE_PLANNER_MODE;
  const paperEntrySlippageBps =
    typeof raw.paperEntrySlippageBps === 'number' && Number.isFinite(raw.paperEntrySlippageBps)
      ? Math.max(0, raw.paperEntrySlippageBps)
      : DEFAULT_PAPER_ENTRY_SLIPPAGE_BPS;
  const paperExitSlippageBps =
    typeof raw.paperExitSlippageBps === 'number' && Number.isFinite(raw.paperExitSlippageBps)
      ? Math.max(0, raw.paperExitSlippageBps)
      : DEFAULT_PAPER_EXIT_SLIPPAGE_BPS;
  const paperPartialFillPct =
    typeof raw.paperPartialFillPct === 'number' && Number.isFinite(raw.paperPartialFillPct)
      ? Math.max(0, Math.min(100, raw.paperPartialFillPct))
      : DEFAULT_PAPER_PARTIAL_FILL_PCT;

  const numericFields = ['priceUpThrPct', 'marginUSDT', 'leverage', 'tpRoiPct', 'slRoiPct'] as const;
  for (const key of numericFields) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      return null;
    }
  }

  if ((raw.tpRoiPct as number) <= 0 || (raw.slRoiPct as number) <= 0 || (raw.marginUSDT as number) <= 0 || (raw.leverage as number) <= 0) {
    return null;
  }

  return {
    mode,
    direction,
    bothTieBreak,
    tf,
    strategyMode,
    holdSeconds,
    signalCounterThreshold,
    signalCounterMin,
    signalCounterMax,
    priceUpThrPct: raw.priceUpThrPct as number,
    oiUpThrPct,
    oiCandleThrPct,
    marginUSDT: raw.marginUSDT as number,
    leverage: raw.leverage as number,
    tpRoiPct: raw.tpRoiPct as number,
    slRoiPct: raw.slRoiPct as number,
    entryOffsetPct,
    maxActiveSymbols,
    dailyLossLimitUSDT,
    maxConsecutiveLosses,
    trendTfMinutes,
    trendLookbackBars,
    trendMinMovePct,
    confirmWindowBars,
    confirmMinContinuationPct,
    impulseMaxAgeBars,
    requireOiTwoCandles,
    maxSecondsIntoCandle,
    minSpreadBps,
    maxSpreadBps,
    maxTickStalenessMs,
    minNotionalUSDT,
    autoTuneEnabled,
    autoTuneScope,
    autoTunePlannerMode,
    paperEntrySlippageBps,
    paperExitSlippageBps,
    paperPartialFillPct
  };
};

export class BotEngine {
  private readonly now: () => number;
  private readonly symbols = new Map<string, SymbolRuntimeState>();
  private readonly demoQueue: DemoOrderQueue;
  private readonly lotSizeBySymbol = new Map<string, Pick<UniverseEntry, 'qtyStep' | 'minOrderQty' | 'maxOrderQty'>>();
  private state: BotState = {
    running: false,
    paused: false,
    hasSnapshot: false,
    startedAt: null,
    runningSinceTs: null,
    activeUptimeMs: 0,
    uptimeMs: 0,
    config: null,
    queueDepth: 0,
    activeOrders: 0,
    openPositions: 0
  };
  private stats: BotStats = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winratePct: 0,
    pnlUSDT: 0,
    avgWinUSDT: null,
    avgLossUSDT: null,
    lossStreak: 0,
    todayPnlUSDT: 0,
    guardrailPauseReason: null,
    long: createEmptySideBreakdown(),
    short: createEmptySideBreakdown(),
    reasonCounts: createEmptyReasonCounts(),
    signalsConfirmed: 0,
    signalsBySide: { long: 0, short: 0 },
    signalsByEntryReason: createEmptyReasonCounts(),
    bothHadBothCount: 0,
    bothChosenLongCount: 0,
    bothChosenShortCount: 0,
    bothTieBreakMode: DEFAULT_BOTH_TIE_BREAK,
    totalFeesUSDT: 0,
    totalSlippageUSDT: 0,
    avgSpreadBpsEntry: null,
    avgSpreadBpsExit: null,
    expectancyUSDT: null,
    profitFactor: null,
    avgFeePerTradeUSDT: null,
    avgNetPerTradeUSDT: null
  };
  private winPnlSum = 0;
  private lossPnlSum = 0;
  private todayPnlDayKey: string | null = null;
  private readonly perSymbolStats = new Map<string, BotPerSymbolAccumulator>();
  private readonly closedTradesNetWindow: number[] = [];
  private spreadEntrySumBps = 0;
  private spreadEntryCount = 0;
  private spreadExitSumBps = 0;
  private spreadExitCount = 0;
  private lastEntryPlacedTs = 0;
  private lastNoEntryLogTs = 0;
  private lastPnlSanityWarnTs = 0;

  constructor(private readonly deps: BotEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.demoQueue = new DemoOrderQueue((snapshot) => {
      this.state = { ...this.state, queueDepth: snapshot.depth };
      this.deps.emitQueueUpdate(snapshot);
      this.persistSnapshot();
    });
  }

  getState(): BotState {
    const now = this.now();
    const uptimeMs = this.state.activeUptimeMs + (this.state.runningSinceTs === null ? 0 : Math.max(0, now - this.state.runningSinceTs));
    return {
      ...this.state,
      ...this.getActivityMetrics(),
      uptimeMs
    };
  }

  getActivityMetrics(): { queueDepth: number; activeOrders: number; openPositions: number } {
    const queueDepth = Number.isFinite(this.state.queueDepth) && this.state.queueDepth > 0 ? Math.floor(this.state.queueDepth) : 0;
    let activeOrders = 0;
    let openPositions = 0;

    for (const symbolState of this.symbols.values()) {
      if (symbolState.pendingOrder) {
        activeOrders += 1;
      }

      if (symbolState.position && Number.isFinite(symbolState.position.qty) && symbolState.position.qty > 0) {
        openPositions += 1;
      }
    }

    return { queueDepth, activeOrders, openPositions };
  }



  applyConfigPatch(patch: Partial<Pick<BotConfig, 'priceUpThrPct' | 'oiUpThrPct' | 'oiCandleThrPct' | 'signalCounterThreshold' | 'impulseMaxAgeBars' | 'minNotionalUSDT' | 'maxSpreadBps' | 'maxTickStalenessMs'>>): BotConfig | null {
    if (!this.state.config) {
      return null;
    }

    for (const [key, value] of Object.entries(patch)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
      }

      if ((key === 'priceUpThrPct' || key === 'oiUpThrPct' || key === 'oiCandleThrPct' || key === 'signalCounterThreshold' || key === 'impulseMaxAgeBars' || key === 'minNotionalUSDT' || key === 'maxSpreadBps' || key === 'maxTickStalenessMs') && value < 0) {
        return null;
      }
    }

    const merged = normalizeBotConfig({
      ...this.state.config,
      ...patch
    } as unknown as Record<string, unknown>);

    if (!merged) {
      return null;
    }

    this.state = {
      ...this.state,
      config: merged
    };
    this.persistSnapshot();
    return this.state.config;
  }

  getRuntimeSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  getStats(): BotStats {
    const perSymbol = Array.from(this.perSymbolStats.entries()).map(([symbol, bucket]) => ({
      symbol,
      trades: bucket.trades,
      wins: bucket.wins,
      losses: bucket.losses,
      winratePct: bucket.trades > 0 ? (bucket.wins / bucket.trades) * 100 : 0,
      pnlUSDT: bucket.pnlUSDT,
      longTrades: bucket.longTrades,
      longWins: bucket.longWins,
      longLosses: bucket.longLosses,
      shortTrades: bucket.shortTrades,
      shortWins: bucket.shortWins,
      shortLosses: bucket.shortLosses,
      signalsAttempted: bucket.signalsAttempted,
      signalsConfirmed: bucket.signalsConfirmed,
      confirmedBySide: { ...bucket.confirmedBySide },
      confirmedByEntryReason: { ...bucket.confirmedByEntryReason },
      avgHoldMs: bucket.closedTradesWithHold > 0 ? bucket.totalHoldMs / bucket.closedTradesWithHold : null,
      lastClosedTs: bucket.lastClosedTs,
      lastClosedPnlUSDT: bucket.lastClosedPnlUSDT
    }));

    const stats = {
      ...this.stats,
      long: { ...this.stats.long },
      short: { ...this.stats.short },
      reasonCounts: { ...this.stats.reasonCounts },
      signalsBySide: { ...this.stats.signalsBySide },
      signalsByEntryReason: { ...this.stats.signalsByEntryReason },
      bothTieBreakMode: this.state.config?.bothTieBreak ?? this.stats.bothTieBreakMode,
      ...(perSymbol.length > 0 ? { perSymbol } : {})
    };
    return this.stats.lastClosed ? { ...stats, lastClosed: { ...this.stats.lastClosed } } : stats;
  }

  resetStats(): void {
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winratePct: 0,
      pnlUSDT: 0,
      avgWinUSDT: null,
      avgLossUSDT: null,
      lossStreak: 0,
      todayPnlUSDT: 0,
      guardrailPauseReason: null,
      long: createEmptySideBreakdown(),
      short: createEmptySideBreakdown(),
      reasonCounts: createEmptyReasonCounts(),
      signalsConfirmed: 0,
      signalsBySide: { long: 0, short: 0 },
      signalsByEntryReason: createEmptyReasonCounts(),
      bothHadBothCount: 0,
      bothChosenLongCount: 0,
      bothChosenShortCount: 0,
      bothTieBreakMode: this.state.config?.bothTieBreak ?? DEFAULT_BOTH_TIE_BREAK,
      totalFeesUSDT: 0,
      totalSlippageUSDT: 0,
      avgSpreadBpsEntry: null,
      avgSpreadBpsExit: null,
      expectancyUSDT: null,
      profitFactor: null,
      avgFeePerTradeUSDT: null,
      avgNetPerTradeUSDT: null
    };
    this.winPnlSum = 0;
    this.lossPnlSum = 0;
    this.todayPnlDayKey = null;
    this.perSymbolStats.clear();
    this.closedTradesNetWindow.length = 0;
    this.spreadEntrySumBps = 0;
    this.spreadEntryCount = 0;
    this.spreadExitSumBps = 0;
    this.spreadExitCount = 0;
    this.lastPnlSanityWarnTs = 0;
    this.persistSnapshot();
  }

  getGuardrails(): Pick<BotConfig, 'maxActiveSymbols' | 'dailyLossLimitUSDT' | 'maxConsecutiveLosses'> {
    const config = this.state.config;
    if (!config) {
      return {
        maxActiveSymbols: DEFAULT_MAX_ACTIVE_SYMBOLS,
        dailyLossLimitUSDT: 0,
        maxConsecutiveLosses: 0
      };
    }

    return {
      maxActiveSymbols: config.maxActiveSymbols,
      dailyLossLimitUSDT: config.dailyLossLimitUSDT,
      maxConsecutiveLosses: config.maxConsecutiveLosses
    };
  }

  setUniverseSymbols(symbols: string[]): void {
    const symbolSet = new Set(symbols);
    for (const symbol of this.symbols.keys()) {
      if (!symbolSet.has(symbol)) {
        this.symbols.delete(symbol);
        this.lotSizeBySymbol.delete(symbol);
      }
    }

    for (const symbol of symbols) {
      if (!this.symbols.has(symbol)) {
        this.symbols.set(symbol, this.buildEmptySymbolState(symbol));
      }

      if (!this.lotSizeBySymbol.has(symbol)) {
        this.lotSizeBySymbol.set(symbol, { qtyStep: null, minOrderQty: null, maxOrderQty: null });
      }
    }
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  setUniverseEntries(entries: UniverseEntry[]): void {
    this.lotSizeBySymbol.clear();
    for (const entry of entries) {
      this.lotSizeBySymbol.set(entry.symbol, {
        qtyStep: entry.qtyStep,
        minOrderQty: entry.minOrderQty,
        maxOrderQty: entry.maxOrderQty
      });
    }

    this.setUniverseSymbols(entries.map((entry) => entry.symbol));
  }

  start(config: BotConfig): void {
    const now = this.now();
    const safeConfig: BotConfig = {
      ...config,
      strategyMode: config.strategyMode ?? DEFAULT_STRATEGY_MODE,
      signalCounterMin: config.signalCounterMin ?? config.signalCounterThreshold ?? DEFAULT_SIGNAL_COUNTER_MIN,
      signalCounterMax: config.signalCounterMax ?? DEFAULT_SIGNAL_COUNTER_MAX,
      autoTuneEnabled: config.autoTuneEnabled ?? DEFAULT_AUTO_TUNE_ENABLED,
      autoTuneScope: config.autoTuneScope ?? DEFAULT_AUTO_TUNE_SCOPE,
      autoTunePlannerMode: config.autoTunePlannerMode ?? DEFAULT_AUTO_TUNE_PLANNER_MODE
    };
    this.state = {
      ...this.state,
      running: true,
      paused: false,
      startedAt: now,
      runningSinceTs: now,
      config: safeConfig
    };
    this.stats.bothTieBreakMode = safeConfig.bothTieBreak;
    this.persistSnapshot();
  }

  stop(): void {
    this.finalizeActiveUptime();
    this.state = {
      ...this.state,
      running: false,
      paused: false,
      runningSinceTs: null
    };
    this.persistSnapshot();
  }

  pause(): void {
    this.finalizeActiveUptime();
    this.state = {
      ...this.state,
      paused: true,
      runningSinceTs: null
    };
    this.persistSnapshot();
  }

  resume(canRun: boolean): boolean {
    const now = this.now();
    this.state = {
      ...this.state,
      paused: false,
      running: canRun ? true : this.state.running,
      runningSinceTs: canRun ? now : this.state.runningSinceTs
    };
    this.persistSnapshot();
    return true;
  }

  restoreFromSnapshot(snapshot: RuntimeSnapshot): void {
    this.symbols.clear();
    for (const [symbol, state] of Object.entries(snapshot.symbols)) {
      this.symbols.set(symbol, {
        symbol,
        fsmState: state.fsmState,
        baseline: state.baseline,
        holdStartTs: null,
        signalEvents: state.signalEvents ?? state.signalEvents24h ?? [],
        lastSignalBucketKey: state.lastSignalBucketKey ?? state.lastSignalBucketStart ?? null,
        signalEvents24h: state.signalEvents24h ?? state.signalEvents ?? [],
        lastSignalBucketStart: state.lastSignalBucketStart ?? state.lastSignalBucketKey ?? null,
        prevCandleOi: state.prevCandleOi ?? null,
        lastCandleOi: state.lastCandleOi ?? null,
        prevCandleMark: state.prevCandleMark ?? null,
        lastCandleMark: state.lastCandleMark ?? null,
        lastCandleBucketStart: state.lastCandleBucketStart ?? null,
        lastEvaluationGateTs: null,
        blockedUntilTs: state.blockedUntilTs,
        overrideGateOnce: state.overrideGateOnce,
        pendingOrder: state.pendingOrder,
        position: state.position,
        demo: state.demo,
        trendCandles5m: [],
        trendCandles15m: [],
        oiCandleDeltaPctHistory: [],
        armedSignal: state.armedSignal
          ? {
              side: state.armedSignal.side,
              triggerMark: state.armedSignal.triggerMark ?? state.armedSignal.baselinePrice ?? 0,
              triggerBucketStart: state.armedSignal.triggerBucketStart ?? state.armedSignal.armedBucketStart ?? 0,
              continuationWindowEndBucketStart:
                state.armedSignal.continuationWindowEndBucketStart ?? state.armedSignal.expireBucketStart ?? 0
            }
          : null,
        noEntryReasonCounts: new Map(),
        lastNoEntryReasons: (state.lastNoEntryReasons ?? []).filter((entry): entry is NoEntryReason =>
          NO_ENTRY_REASON_CODES.includes(entry.code as NoEntryReason['code'])
        ),
        entryReason: state.entryReason ?? null,
        lastPriceDeltaPct: state.lastPriceDeltaPct ?? null,
        lastOiDeltaPct: state.lastOiDeltaPct ?? null,
        lastSignalCount24h: state.lastSignalCount24h ?? 0,
        gates: state.gates ?? null,
        lastBothCandidate: state.lastBothCandidate ?? null
      });
    }

    this.state = {
      ...this.state,
      running: false,
      paused: true,
      hasSnapshot: true,
      startedAt: null,
      runningSinceTs: null,
      activeUptimeMs: snapshot.activeUptimeMs ?? 0,
      uptimeMs: 0,
      config: snapshot.config ? { ...snapshot.config, bothTieBreak: snapshot.config.bothTieBreak ?? DEFAULT_BOTH_TIE_BREAK, strategyMode: snapshot.config.strategyMode ?? DEFAULT_STRATEGY_MODE, signalCounterMin: snapshot.config.signalCounterMin ?? snapshot.config.signalCounterThreshold ?? DEFAULT_SIGNAL_COUNTER_MIN, signalCounterMax: snapshot.config.signalCounterMax ?? DEFAULT_SIGNAL_COUNTER_MAX, autoTuneEnabled: snapshot.config.autoTuneEnabled ?? DEFAULT_AUTO_TUNE_ENABLED, autoTuneScope: snapshot.config.autoTuneScope ?? DEFAULT_AUTO_TUNE_SCOPE, autoTunePlannerMode: snapshot.config.autoTunePlannerMode ?? DEFAULT_AUTO_TUNE_PLANNER_MODE } : null
    };

    this.perSymbolStats.clear();

    if (snapshot.stats) {
      this.stats = {
        totalTrades: snapshot.stats.totalTrades,
        wins: snapshot.stats.wins,
        losses: snapshot.stats.losses,
        winratePct: snapshot.stats.winratePct,
        pnlUSDT: snapshot.stats.pnlUSDT,
        avgWinUSDT: snapshot.stats.avgWinUSDT,
        avgLossUSDT: snapshot.stats.avgLossUSDT,
        lossStreak: snapshot.stats.lossStreak ?? 0,
        todayPnlUSDT: snapshot.stats.todayPnlUSDT ?? 0,
        guardrailPauseReason: snapshot.stats.guardrailPauseReason ?? null,
        long: snapshot.stats.long ?? createEmptySideBreakdown(),
        short: snapshot.stats.short ?? createEmptySideBreakdown(),
        reasonCounts: snapshot.stats.reasonCounts ?? createEmptyReasonCounts(),
        signalsConfirmed: snapshot.stats.signalsConfirmed ?? 0,
        signalsBySide: snapshot.stats.signalsBySide ?? { long: 0, short: 0 },
        signalsByEntryReason: snapshot.stats.signalsByEntryReason ?? createEmptyReasonCounts(),
        bothHadBothCount: snapshot.stats.bothHadBothCount ?? 0,
        bothChosenLongCount: snapshot.stats.bothChosenLongCount ?? 0,
        bothChosenShortCount: snapshot.stats.bothChosenShortCount ?? 0,
        bothTieBreakMode: snapshot.stats.bothTieBreakMode ?? snapshot.config?.bothTieBreak ?? DEFAULT_BOTH_TIE_BREAK,
        totalFeesUSDT: snapshot.stats.totalFeesUSDT ?? 0,
        totalSlippageUSDT: snapshot.stats.totalSlippageUSDT ?? 0,
        avgSpreadBpsEntry: snapshot.stats.avgSpreadBpsEntry ?? null,
        avgSpreadBpsExit: snapshot.stats.avgSpreadBpsExit ?? null,
        expectancyUSDT: snapshot.stats.expectancyUSDT ?? null,
        profitFactor: snapshot.stats.profitFactor ?? null,
        avgFeePerTradeUSDT: snapshot.stats.avgFeePerTradeUSDT ?? null,
        avgNetPerTradeUSDT: snapshot.stats.avgNetPerTradeUSDT ?? null,
        ...(snapshot.stats.lastClosed ? { lastClosed: snapshot.stats.lastClosed } : {})
      };
      this.winPnlSum = snapshot.stats.wins * (snapshot.stats.avgWinUSDT ?? 0);
      this.lossPnlSum = snapshot.stats.losses * (snapshot.stats.avgLossUSDT ?? 0);
      this.todayPnlDayKey = new Date(this.now()).toISOString().slice(0, 10);
      this.spreadEntryCount = snapshot.stats.avgSpreadBpsEntry === null || snapshot.stats.avgSpreadBpsEntry === undefined ? 0 : snapshot.stats.totalTrades;
      this.spreadEntrySumBps = (snapshot.stats.avgSpreadBpsEntry ?? 0) * this.spreadEntryCount;
      this.spreadExitCount = snapshot.stats.avgSpreadBpsExit === null || snapshot.stats.avgSpreadBpsExit === undefined ? 0 : snapshot.stats.totalTrades;
      this.spreadExitSumBps = (snapshot.stats.avgSpreadBpsExit ?? 0) * this.spreadExitCount;
      this.perSymbolStats.clear();
      for (const entry of snapshot.stats.perSymbol ?? []) {
        this.perSymbolStats.set(entry.symbol, {
          trades: entry.trades,
          wins: entry.wins,
          losses: entry.losses,
          pnlUSDT: entry.pnlUSDT,
          longTrades: entry.longTrades,
          longWins: entry.longWins,
          longLosses: entry.longLosses,
          shortTrades: entry.shortTrades,
          shortWins: entry.shortWins,
          shortLosses: entry.shortLosses,
          signalsAttempted: entry.signalsAttempted ?? 0,
          signalsConfirmed: entry.signalsConfirmed ?? 0,
          confirmedBySide: entry.confirmedBySide ?? { long: 0, short: 0 },
          confirmedByEntryReason: entry.confirmedByEntryReason ?? createEmptyReasonCounts(),
          totalHoldMs: typeof entry.avgHoldMs === 'number' && Number.isFinite(entry.avgHoldMs) ? entry.avgHoldMs * entry.trades : 0,
          closedTradesWithHold: typeof entry.avgHoldMs === 'number' && Number.isFinite(entry.avgHoldMs) ? entry.trades : 0,
          lastClosedTs: entry.lastClosedTs ?? null,
          lastClosedPnlUSDT: entry.lastClosedPnlUSDT ?? null
        });
      }
    }

    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  clearSnapshotState(): void {
    this.state = {
      ...this.state,
      hasSnapshot: false
    };

    this.deps.snapshotStore?.clear();
  }

  clearPersistedRuntime(): void {
    this.clearSnapshotState();
  }

  resetRuntimeStateForAllSymbols(): void {
    for (const [symbol, symbolState] of this.symbols.entries()) {
      this.symbols.set(symbol, {
        ...this.buildEmptySymbolState(symbol),
        baseline: symbolState.baseline ? { ...symbolState.baseline } : null,
        prevCandleOi: symbolState.prevCandleOi,
        lastCandleOi: symbolState.lastCandleOi,
        prevCandleMark: symbolState.prevCandleMark,
        lastCandleMark: symbolState.lastCandleMark,
        lastCandleBucketStart: symbolState.lastCandleBucketStart
      });
    }

    this.state = {
      ...this.state,
      queueDepth: 0
    };
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  getSymbolState(symbol: string): SymbolRuntimeState | undefined {
    const symbolState = this.symbols.get(symbol);
    if (!symbolState) {
      return undefined;
    }

    return {
      ...symbolState,
      baseline: symbolState.baseline ? { ...symbolState.baseline } : null,
      pendingOrder: symbolState.pendingOrder ? { ...symbolState.pendingOrder } : null,
      position: symbolState.position ? { ...symbolState.position } : null,
      demo: symbolState.demo ? { ...symbolState.demo } : null,
      signalEvents: [...symbolState.signalEvents],
      lastSignalBucketKey: symbolState.lastSignalBucketKey,
      signalEvents24h: [...symbolState.signalEvents24h],
      lastSignalBucketStart: symbolState.lastSignalBucketStart,
      prevCandleOi: symbolState.prevCandleOi,
      lastCandleOi: symbolState.lastCandleOi,
      prevCandleMark: symbolState.prevCandleMark,
      lastCandleMark: symbolState.lastCandleMark,
      lastCandleBucketStart: symbolState.lastCandleBucketStart,
      trendCandles5m: symbolState.trendCandles5m.map((candle) => ({ ...candle })),
      trendCandles15m: symbolState.trendCandles15m.map((candle) => ({ ...candle })),
      oiCandleDeltaPctHistory: [...symbolState.oiCandleDeltaPctHistory],
      armedSignal: symbolState.armedSignal ? { ...symbolState.armedSignal } : null,
      noEntryReasonCounts: new Map(symbolState.noEntryReasonCounts),
      lastNoEntryReasons: [...symbolState.lastNoEntryReasons],
      entryReason: symbolState.entryReason,
      lastPriceDeltaPct: symbolState.lastPriceDeltaPct,
      lastOiDeltaPct: symbolState.lastOiDeltaPct,
      lastSignalCount24h: symbolState.lastSignalCount24h,
      gates: symbolState.gates ? { ...symbolState.gates } : null,
      lastBothCandidate: symbolState.lastBothCandidate ? { ...symbolState.lastBothCandidate } : null
    };
  }

  async cancelPendingOrder(symbol: string, marketState: MarketState): Promise<boolean> {
    const symbolState = this.symbols.get(symbol);
    if (!symbolState || !symbolState.pendingOrder || symbolState.fsmState !== 'ENTRY_PENDING') {
      return false;
    }

    await this.cancelSymbolPendingOrder(symbolState, marketState, 'CANCELLED');
    return true;
  }

  async killSwitch(getMarketState: (symbol: string) => MarketState | undefined): Promise<KillSwitchResult> {
    let cancelledOrders = 0;
    let closedPositions = 0;
    const warnings: string[] = [];
    this.pauseWithGuardrail('KILL_SWITCH');

    for (const symbolState of this.symbols.values()) {
      const marketState =
        getMarketState(symbolState.symbol) ?? {
          markPrice: symbolState.pendingOrder?.limitPrice ?? symbolState.position?.entryPrice ?? 0,
          openInterestValue: symbolState.baseline?.baseOiValue ?? 0,
          ts: this.now(),
          lastPrice: null,
          bid: null,
          ask: null,
          spreadBps: null,
          lastTickTs: this.now()
        };

      if (symbolState.fsmState === 'ENTRY_PENDING' && symbolState.pendingOrder) {
        await this.cancelSymbolPendingOrder(symbolState, marketState, 'CANCELLED');
        cancelledOrders += 1;
      }

      if (!symbolState.position) {
        continue;
      }

      if (this.state.config?.mode === 'demo' && this.deps.demoTradeClient) {
        let demoCloseConfirmed = false;
        try {
          const openOrders = await this.deps.demoTradeClient.getOpenOrders(symbolState.symbol);
          for (const order of openOrders) {
            await this.deps.demoTradeClient.cancelOrder({ symbol: symbolState.symbol, orderId: order.orderId, orderLinkId: order.orderLinkId });
          }

          await this.deps.demoTradeClient.closePositionMarket({
            symbol: symbolState.symbol,
            side: symbolState.position.side === 'LONG' ? 'Sell' : 'Buy',
            qty: symbolState.position.qty.toString(),
            positionIdx: symbolState.position.side === 'LONG' ? 1 : 2
          });

          let closeAttemptedTwice = false;
          const startedAt = this.now();
          let waitMs = 250;
          while (this.now() - startedAt < 10_000) {
            const position = await this.deps.demoTradeClient.getPosition(symbolState.symbol);
            const size = position?.size;
            const isClosed = !position || typeof size !== 'number' || !Number.isFinite(size) || Math.abs(size) <= 0;
            if (isClosed) {
              demoCloseConfirmed = true;
              break;
            }

            if (!closeAttemptedTwice && this.now() - startedAt >= 2_500) {
              closeAttemptedTwice = true;
              await this.deps.demoTradeClient.closePositionMarket({
                symbol: symbolState.symbol,
                side: symbolState.position.side === 'LONG' ? 'Sell' : 'Buy',
                qty: symbolState.position.qty.toString(),
                positionIdx: symbolState.position.side === 'LONG' ? 1 : 2
              });
            }

            await new Promise((resolve) => setTimeout(resolve, waitMs));
            waitMs = Math.min(waitMs + 150, 1200);
          }

          if (!demoCloseConfirmed) {
            warnings.push(`Demo close timeout waiting close confirmation for ${symbolState.symbol}`);
            continue;
          }
        } catch (error) {
          const message = (error as Error).message;
          const reason = message.includes('10001') ? 'positionIdx mismatch' : 'exchange close error';
          warnings.push(`Demo close failed (${reason}) for ${symbolState.symbol}: ${message}`);
          continue;
        }
      }

      this.forceClosePosition(symbolState, marketState);
      closedPositions += 1;
    }

    this.updateSummaryCounts();
    this.persistSnapshot();
    const metrics = this.getActivityMetrics();
    return {
      cancelledOrders,
      closedPositions,
      warning: warnings.length > 0 ? warnings.join(' | ') : null,
      activeOrdersRemaining: metrics.activeOrders,
      openPositionsRemaining: metrics.openPositions
    };
  }

  private forceClosePosition(symbolState: SymbolRuntimeState, marketState: MarketState): void {
    const position = symbolState.position;
    if (!position) {
      return;
    }

    const exitPrice = marketState.markPrice;
    const entryFeeRate = PAPER_FEES.makerFeeRate;
    const exitFeeRate = PAPER_FEES.takerFeeRate;
    const {
      grossPnlUSDT: grossPnl,
      entryFeeUSDT,
      exitFeeUSDT,
      feeTotalUSDT,
      netPnlUSDT
    } = computePnlBreakdown({
      side: position.side,
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice,
      entryFeeRate,
      exitFeeRate,
      slippageUSDT: null
    });

    const closedPosition: PaperPosition = {
      ...position,
      closeReason: 'KILL',
      exitPrice,
      realizedGrossPnlUSDT: grossPnl,
      grossPnlUSDT: grossPnl,
      feesUSDT: feeTotalUSDT,
      entryFeeUSDT,
      exitFeeUSDT,
      feeTotalUSDT,
      realizedNetPnlUSDT: netPnlUSDT,
      netPnlUSDT,
      entryFeeRate,
      exitFeeRate,
      exitSlippageBpsApplied: 0,
      spreadBpsAtExit: marketState.spreadBps ?? null,
      slippageUSDT: null,
      lastPnlUSDT: netPnlUSDT
    };

    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    symbolState.holdStartTs = null;
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position: closedPosition,
      exitPrice,
      pnlUSDT: netPnlUSDT,
      closeReason: 'KILL',
      realizedGrossPnlUSDT: grossPnl,
      feesUSDT: feeTotalUSDT,
      realizedNetPnlUSDT: netPnlUSDT,
      entryFeeUSDT,
      exitFeeUSDT,
      entryFeeRate,
      exitFeeRate
    });
    this.recordClosedTrade(symbolState.symbol, position.side, grossPnl, feeTotalUSDT, netPnlUSDT, 'KILL', entryFeeUSDT, exitFeeUSDT, position.openedTs, null, position.spreadBpsAtEntry ?? null, marketState.spreadBps ?? null);
  }

  async pollDemoOrders(allMarketStates: Record<string, MarketState>): Promise<void> {
    if (this.state.config?.mode !== 'demo' || !this.deps.demoTradeClient) {
      return;
    }

    const hasMonitorableSymbols = Array.from(this.symbols.values()).some((symbolState) => symbolState.pendingOrder || symbolState.position);
    if (!this.state.running && !hasMonitorableSymbols) {
      return;
    }

    for (const symbolState of this.symbols.values()) {
      if (!symbolState.pendingOrder && !symbolState.position) {
        continue;
      }

      const marketState = allMarketStates[symbolState.symbol];
      if (!marketState) {
        continue;
      }

      const startedAsPositionOpen = symbolState.fsmState === 'POSITION_OPEN';
      if (symbolState.fsmState === 'ENTRY_PENDING' && symbolState.pendingOrder) {
        const openOrders = await this.deps.demoTradeClient.getOpenOrders(symbolState.symbol);
        await this.processDemoEntryPending(symbolState, marketState, openOrders);
      }

      if (startedAsPositionOpen && symbolState.fsmState === 'POSITION_OPEN' && symbolState.position) {
        const position = await this.deps.demoTradeClient.getPosition(symbolState.symbol);
        await this.processDemoOpenPosition(symbolState, marketState, position);
      }
    }
  }

  onMarketUpdate(symbol: string, marketState: MarketState): void {
    if (!this.state.config) {
      return;
    }

    const symbolState = this.symbols.get(symbol);
    if (!symbolState) {
      return;
    }

    if (!this.enforceStateInvariant(symbolState, 'pre-market-update', marketState)) {
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    const now = this.now();
    const bucketStart = this.computeTfBucketStart(now);
    const isNewBucket = symbolState.lastCandleBucketStart === null || symbolState.lastCandleBucketStart !== bucketStart;
    this.updateTrendState(symbolState, marketState.markPrice, now);
    this.updateCandlePriceState(symbolState, marketState.markPrice, bucketStart, isNewBucket);
    this.updateCandleOiState(symbolState, marketState.openInterestValue, bucketStart, isNewBucket);
    this.updateGateSnapshot(symbolState, marketState);

    if (!symbolState.baseline) {
      this.resetBaseline(symbolState, marketState);
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    if (symbolState.fsmState === 'ENTRY_PENDING') {
      this.lastEntryPlacedTs = now;

    if (this.state.config.mode === 'paper') {
        this.processPendingPaperOrder(symbolState, marketState);
      }
      return;
    }

    if (symbolState.fsmState === 'POSITION_OPEN') {
      this.lastEntryPlacedTs = now;

    if (this.state.config.mode === 'paper') {
        this.processOpenPosition(symbolState, marketState);
      }
      return;
    }

    if (!this.state.running || this.state.paused) {
      this.recordNoEntryReason(symbolState, { code: 'GUARDRAIL_PAUSED', message: 'Bot paused/running disabled.' });
      return;
    }

    if (now < symbolState.blockedUntilTs) {
      return;
    }

    const hadArmedSignal = !!symbolState.armedSignal;
    if (this.tryConfirmArmedSignal(symbolState, marketState, now)) {
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    if (hadArmedSignal) {
      this.persistSnapshot();
      return;
    }

    if (!this.canEvaluateAtCurrentGate(symbolState, now)) {
      return;
    }

    const { priceDeltaPct, oiDeltaPct } = this.computeDeltas(symbolState, marketState);
    symbolState.lastPriceDeltaPct = priceDeltaPct;
    symbolState.lastOiDeltaPct = oiDeltaPct;
    const candidate = this.getEligibleSignal(symbolState, priceDeltaPct, oiDeltaPct);
    symbolState.lastBothCandidate = candidate?.bothCandidate ?? null;
    if (symbolState.gates) {
      if (candidate?.bothCandidate?.hadBoth) {
        symbolState.gates.bothCandidate = { ...candidate.bothCandidate };
      } else {
        delete symbolState.gates.bothCandidate;
      }
    }
    if (!candidate) {
      this.recordNoEntryReason(symbolState, {
        code: 'SIGNAL_COUNTER_NOT_MET',
        message: 'Signal conditions not met.',
        value: 0,
        threshold: this.state.config.signalCounterMin
      });
      this.resetToIdle(symbolState);
      this.persistSnapshot();
      return;
    }

    const perSymbolSignalStatsAttempt = this.getOrCreatePerSymbolStats(symbol);
    perSymbolSignalStatsAttempt.signalsAttempted += 1;

    const trendDeltaPct = this.getTrendDeltaPct(symbolState, this.state.config.trendTfMinutes, this.state.config.trendLookbackBars);
    if (trendDeltaPct !== null) {
      const trendBlocked =
        (candidate.side === 'LONG' && trendDeltaPct <= -this.state.config.trendMinMovePct) ||
        (candidate.side === 'SHORT' && trendDeltaPct >= this.state.config.trendMinMovePct);
      if (trendBlocked) {
        if (symbolState.gates) {
          symbolState.gates.trendBlocked = true;
          symbolState.gates.trendBlockReason = candidate.side === 'LONG' ? 'TREND_BLOCK_LONG' : 'TREND_BLOCK_SHORT';
        }
        this.recordNoEntryReason(symbolState, {
          code: candidate.side === 'LONG' ? 'TREND_BLOCK_LONG' : 'TREND_BLOCK_SHORT',
          message: `Trend ${this.state.config.trendTfMinutes}m blocks ${candidate.side}.`,
          value: trendDeltaPct,
          threshold: this.state.config.trendMinMovePct
        });
        this.resetToIdle(symbolState);
        this.persistSnapshot();
        return;
      }
    }

    const secondsIntoCandle = Math.floor((now - this.computeTfBucketStart(now)) / 1000);
    if (secondsIntoCandle > this.state.config.maxSecondsIntoCandle) {
      this.recordNoEntryReason(symbolState, {
        code: 'IMPULSE_TOO_LATE',
        message: 'Impulse crossed threshold too late in candle.',
        value: secondsIntoCandle,
        threshold: this.state.config.maxSecondsIntoCandle
      });
      this.resetToIdle(symbolState);
      this.persistSnapshot();
      return;
    }

    const signalCount24h = this.recordSignalEventAndGetCount(symbolState, now);
    symbolState.lastSignalCount24h = signalCount24h;
    const minCount = this.state.config.signalCounterMin;
    const maxCount = this.state.config.signalCounterMax;
    const confirmed = signalCount24h >= minCount && signalCount24h <= maxCount;
    symbolState.fsmState = candidate.side === 'LONG' ? 'HOLDING_LONG' : 'HOLDING_SHORT';
    symbolState.entryReason = candidate.entryReason;
    symbolState.holdStartTs = now;

    if (!confirmed) {
      this.recordNoEntryReason(symbolState, {
        code: 'SIGNAL_COUNTER_OUT_OF_RANGE',
        message: `Need ${minCount} signals in last 24h (count=${signalCount24h}).`,
        value: signalCount24h,
        threshold: minCount
      });
      this.persistSnapshot();
      return;
    }

    this.stats.signalsConfirmed += 1;
    if (candidate.side === 'LONG') {
      this.stats.signalsBySide.long += 1;
    } else {
      this.stats.signalsBySide.short += 1;
    }
    if (candidate.bothCandidate?.hadBoth) {
      this.stats.bothHadBothCount += 1;
      if (candidate.bothCandidate.chosen === 'long') {
        this.stats.bothChosenLongCount += 1;
      } else {
        this.stats.bothChosenShortCount += 1;
      }
    }
    this.stats.signalsByEntryReason[candidate.entryReason] += 1;

    const perSymbolSignalStats = this.getOrCreatePerSymbolStats(symbol);
    perSymbolSignalStats.signalsConfirmed += 1;
    if (candidate.side === 'LONG') {
      perSymbolSignalStats.confirmedBySide.long += 1;
    } else {
      perSymbolSignalStats.confirmedBySide.short += 1;
    }
    perSymbolSignalStats.confirmedByEntryReason[candidate.entryReason] += 1;

    this.deps.emitSignal({
      symbol,
      side: candidate.side,
      markPrice: marketState.markPrice,
      oiValue: marketState.openInterestValue,
      priceDeltaPct,
      oiDeltaPct,
      entryReason: candidate.entryReason,
      ...(candidate.bothCandidate?.hadBoth ? { bothCandidate: candidate.bothCandidate } : {})
    });

    this.stats.reasonCounts[candidate.entryReason] += 1;

    if (this.state.config.confirmMinContinuationPct <= 0) {
      this.tryPlaceEntryOrder(symbolState, marketState, candidate.side);
      this.persistSnapshot();
      return;
    }

    symbolState.armedSignal = {
      side: candidate.side,
      triggerMark: marketState.markPrice,
      triggerBucketStart: this.computeTfBucketStart(now),
      continuationWindowEndBucketStart: this.computeTfBucketStart(now) + this.state.config.tf * 60_000 * this.state.config.confirmWindowBars
    };
    symbolState.fsmState = candidate.side === 'LONG' ? 'ARMED_LONG' : 'ARMED_SHORT';
    this.persistSnapshot();
  }

  private tryConfirmArmedSignal(symbolState: SymbolRuntimeState, marketState: MarketState, now: number): boolean {
    if (!symbolState.armedSignal) {
      return false;
    }

    const currentBucket = this.computeTfBucketStart(now);
    const armed = symbolState.armedSignal;
    if (currentBucket <= armed.triggerBucketStart) {
      return false;
    }

    const ageBars = Math.floor((currentBucket - armed.triggerBucketStart) / (this.state.config!.tf * 60_000));
    if (symbolState.gates) {
      symbolState.gates.impulseAgeMs = Math.max(0, this.now() - armed.triggerBucketStart);
    }
    if (ageBars > this.state.config!.impulseMaxAgeBars) {
      this.recordNoEntryReason(symbolState, {
        code: 'IMPULSE_STALE',
        message: `Impulse stale at ${ageBars} bars.`,
        value: ageBars,
        threshold: this.state.config!.impulseMaxAgeBars
      });
      symbolState.armedSignal = null;
      this.resetToIdle(symbolState);
      return false;
    }

    const movePct = ((marketState.markPrice - armed.triggerMark) / armed.triggerMark) * 100;
    const moveOk = armed.side === 'LONG' ? movePct >= this.state.config!.confirmMinContinuationPct : movePct <= -this.state.config!.confirmMinContinuationPct;
    if (symbolState.gates) {
      symbolState.gates.continuationOk = moveOk;
      symbolState.gates.confirmZ = movePct;
      symbolState.gates.confirmCount = symbolState.lastSignalCount24h;
    }
    if (!moveOk) {
      if (currentBucket > armed.continuationWindowEndBucketStart) {
        this.recordNoEntryReason(symbolState, {
          code: 'NO_CONTINUATION',
          message: `No continuation in ${this.state.config!.confirmWindowBars} bars.`,
          value: Math.abs(movePct),
          threshold: this.state.config!.confirmMinContinuationPct
        });
        symbolState.armedSignal = null;
        this.resetToIdle(symbolState);
      }
      return false;
    }

    symbolState.armedSignal = null;
    return this.tryPlaceEntryOrder(symbolState, marketState, armed.side);
  }

  private tryPlaceEntryOrder(symbolState: SymbolRuntimeState, marketState: MarketState, side: 'LONG' | 'SHORT'): boolean {
    if (!this.passesCurrentLiquidityGates(symbolState, marketState)) {
      this.resetToIdle(symbolState);
      return false;
    }

    const leverage = this.state.config!.leverage;
    const entryNotional = this.state.config!.marginUSDT * leverage;
    if (entryNotional < this.state.config!.minNotionalUSDT) {
      this.recordNoEntryReason(symbolState, {
        code: 'NOTIONAL_TOO_SMALL',
        message: 'Entry notional below minNotionalUSDT.',
        value: entryNotional,
        threshold: this.state.config!.minNotionalUSDT
      });
      this.resetToIdle(symbolState);
      return false;
    }

    if (!this.isOiTwoCandlesGateTrue(symbolState, symbolState.entryReason, side)) {
      this.recordNoEntryReason(symbolState, {
        code: 'OI_2CANDLES_FAIL',
        message: 'Two-candle OI continuation gate failed.',
        value: symbolState.oiCandleDeltaPctHistory.at(-1),
        threshold: this.state.config!.oiCandleThrPct
      });
      this.resetToIdle(symbolState);
      return false;
    }

    const entryPrice = side === 'LONG'
      ? marketState.markPrice * (1 - percentToFraction(Math.max(0, this.state.config!.entryOffsetPct)))
      : marketState.markPrice * (1 + percentToFraction(Math.max(0, this.state.config!.entryOffsetPct)));
    const rawQty = entryNotional / entryPrice;
    const lotSize = this.lotSizeBySymbol.get(symbolState.symbol);
    const qty = lotSize && lotSize.qtyStep !== null && lotSize.minOrderQty !== null
      ? normalizeQty(rawQty, lotSize.qtyStep, lotSize.minOrderQty, lotSize.maxOrderQty)
      : this.roundQty(rawQty);

    if (qty === null || qty <= 0) {
      this.recordNoEntryReason(symbolState, {
        code: 'QTY_BELOW_MIN',
        message: 'Qty below min order qty after normalization.',
        value: rawQty,
        threshold: lotSize?.minOrderQty ?? 0
      });
      this.deps.emitLog?.(`Skipped ${symbolState.symbol}: qty below minOrderQty or invalid after lot-size normalization.`);
      this.resetToIdle(symbolState);
      return false;
    }

    if (this.getActiveSymbolsCount() >= this.state.config!.maxActiveSymbols) {
      this.recordNoEntryReason(symbolState, {
        code: 'MAX_ACTIVE_REACHED',
        message: 'maxActiveSymbols reached.',
        value: this.getActiveSymbolsCount(),
        threshold: this.state.config!.maxActiveSymbols
      });
      this.deps.emitLog?.('Guardrail: maxActiveSymbols reached');
      this.resetToIdle(symbolState);
      return false;
    }

    this.placeConfirmedOrder(symbolState, marketState, side, qty);
    return true;
  }

  private passesCurrentLiquidityGates(symbolState: SymbolRuntimeState, marketState: MarketState): boolean {
    const maxSpreadBps = this.state.config!.maxSpreadBps;
    if (symbolState.gates) {
      symbolState.gates.spreadBps = marketState.spreadBps ?? null;
    }
    if (maxSpreadBps > 0) {
      if (marketState.bid === null || marketState.ask === null || marketState.spreadBps === null) {
        this.recordNoEntryReason(symbolState, {
          code: 'NO_BIDASK',
          message: 'Bid/ask missing for spread gate.',
          threshold: maxSpreadBps
        });
        return false;
      }

      if (marketState.spreadBps > maxSpreadBps) {
        this.recordNoEntryReason(symbolState, {
          code: 'SPREAD_TOO_WIDE',
          message: 'Spread exceeds maxSpreadBps.',
          value: marketState.spreadBps,
          threshold: maxSpreadBps
        });
        return false;
      }
    }

    const maxTickStalenessMs = this.state.config!.maxTickStalenessMs;
    if (maxTickStalenessMs > 0) {
      const lastTickTs = marketState.lastTickTs ?? marketState.ts;
      const stalenessMs = Math.max(0, this.now() - lastTickTs);
      if (symbolState.gates) {
        symbolState.gates.tickAgeMs = stalenessMs;
      }
      if (stalenessMs > maxTickStalenessMs) {
        this.recordNoEntryReason(symbolState, {
          code: 'TICK_STALE',
          message: 'Latest tick is stale for entry.',
          value: stalenessMs,
          threshold: maxTickStalenessMs
        });
        return false;
      }
    }

    return true;
  }

  private updateGateSnapshot(symbolState: SymbolRuntimeState, marketState: MarketState): void {
    if (!this.state.config) {
      return;
    }

    const trendDeltaPct = this.getTrendDeltaPct(symbolState, this.state.config.trendTfMinutes, this.state.config.trendLookbackBars);
    const trendDir =
      trendDeltaPct === null
        ? null
        : trendDeltaPct > this.state.config.trendMinMovePct
          ? 'up'
          : trendDeltaPct < -this.state.config.trendMinMovePct
            ? 'down'
            : 'flat';

    const tickAgeMs = marketState.lastTickTs ? Math.max(0, this.now() - marketState.lastTickTs) : null;
    symbolState.gates = {
      tf: this.state.config.tf,
      higherTfMinutes: this.state.config.trendTfMinutes,
      trendDir,
      trendBlocked: false,
      confirmWindowBars: this.state.config.confirmWindowBars,
      confirmCount: symbolState.lastSignalCount24h,
      confirmZ: symbolState.lastPriceDeltaPct,
      oiCandleValue: symbolState.lastCandleOi,
      oiPrevCandleValue: symbolState.prevCandleOi,
      oiCandleDeltaPct: symbolState.oiCandleDeltaPctHistory.at(-1) ?? null,
      continuationOk: null,
      impulseAgeMs: symbolState.armedSignal ? Math.max(0, this.now() - symbolState.armedSignal.triggerBucketStart) : null,
      spreadBps: marketState.spreadBps,
      tickAgeMs
    };
  }

  private updateTrendState(symbolState: SymbolRuntimeState, markPrice: number, now: number): void {
    this.updateTrendBucket(symbolState, markPrice, now, 5, this.state.config?.trendLookbackBars ?? DEFAULT_TREND_LOOKBACK_BARS);
    this.updateTrendBucket(symbolState, markPrice, now, 15, this.state.config?.trendLookbackBars ?? DEFAULT_TREND_LOOKBACK_BARS);
  }

  private updateTrendBucket(symbolState: SymbolRuntimeState, markPrice: number, now: number, tf: 5 | 15, lookbackBars: number): void {
    const bucketStart = Math.floor(now / (tf * 60_000)) * tf * 60_000;
    const candles = tf === 5 ? symbolState.trendCandles5m : symbolState.trendCandles15m;
    const last = candles.at(-1);
    if (!last || last.bucketStart !== bucketStart) {
      candles.push({ bucketStart, openTs: now, closeTs: now, open: markPrice, high: markPrice, low: markPrice, close: markPrice });
    } else {
      last.closeTs = now;
      last.close = markPrice;
      last.high = Math.max(last.high, markPrice);
      last.low = Math.min(last.low, markPrice);
    }

    const maxBars = lookbackBars + 5;
    if (candles.length > maxBars) {
      candles.splice(0, candles.length - maxBars);
    }
  }

  private getTrendDeltaPct(symbolState: SymbolRuntimeState, tf: 5 | 15, lookbackBars: number): number | null {
    const candles = tf === 5 ? symbolState.trendCandles5m : symbolState.trendCandles15m;
    if (candles.length <= lookbackBars) {
      return null;
    }

    const lookbackClose = candles[candles.length - 1 - lookbackBars]?.close;
    const lastClose = candles.at(-1)?.close;
    if (!lookbackClose || !lastClose || lookbackClose <= 0) {
      return null;
    }

    return ((lastClose - lookbackClose) / lookbackClose) * 100;
  }

  private recordNoEntryReason(symbolState: SymbolRuntimeState, reason: NoEntryReason): void {
    const count = symbolState.noEntryReasonCounts.get(reason.code) ?? 0;
    symbolState.noEntryReasonCounts.set(reason.code, count + 1);
    symbolState.lastNoEntryReasons = [reason, ...symbolState.lastNoEntryReasons.filter((entry) => entry.code !== reason.code)].slice(0, 3);
    const now = this.now();
    if (now - this.lastEntryPlacedTs >= 10_000 && now - this.lastNoEntryLogTs >= 10_000 && symbolState.lastNoEntryReasons.length > 0) {
      const rendered = symbolState.lastNoEntryReasons
        .slice(0, 3)
        .map((entry, index) => `${index + 1}) ${this.formatNoEntryReason(symbolState, entry)}`)
        .join(' | ');
      this.deps.emitLog?.(`No entry (${symbolState.symbol}) (top reasons): ${rendered}`);
      this.lastNoEntryLogTs = now;
    }
  }

  private formatNoEntryReason(symbolState: SymbolRuntimeState, entry: NoEntryReason): string {
    const gates = symbolState.gates;
    if (entry.code === 'TREND_BLOCK_LONG' || entry.code === 'TREND_BLOCK_SHORT') {
      const dir = gates?.trendDir ?? 'unknown';
      const need = entry.code === 'TREND_BLOCK_LONG' ? 'trend!=down' : 'trend!=up';
      return `${entry.code} (trend=${dir} on ${this.state.config?.trendTfMinutes ?? 5}m; need ${need})`;
    }
    if (entry.code === 'SPREAD_TOO_WIDE') {
      return `${entry.code} (spread=${(gates?.spreadBps ?? entry.value ?? 0).toFixed(2)}bps > max=${(entry.threshold ?? 0).toFixed(2)}bps)`;
    }
    if (entry.code === 'OI_2CANDLES_FAIL' || entry.code === 'OI_CANDLE_GATE_FAIL') {
      const delta = gates?.oiCandleDeltaPct ?? entry.value ?? 0;
      return `${entry.code} (oiCandleDeltaPct=${delta.toFixed(2)}% <= thr=${(entry.threshold ?? this.state.config?.oiCandleThrPct ?? 0).toFixed(2)}%)`;
    }
    if (entry.code === 'TICK_STALE') {
      return `${entry.code} (tickAgeMs=${Math.round(gates?.tickAgeMs ?? entry.value ?? 0)} > max=${Math.round(entry.threshold ?? 0)})`;
    }
    if (entry.code === 'NO_CONTINUATION') {
      return `${entry.code} (confirmZ=${(gates?.confirmZ ?? 0).toFixed(3)}%; need >=${(this.state.config?.confirmMinContinuationPct ?? 0).toFixed(3)}%)`;
    }
    if (entry.code === 'SIGNAL_COUNTER_OUT_OF_RANGE') {
      return `${entry.code} (Need ${this.state.config?.signalCounterThreshold ?? this.state.config?.signalCounterMin ?? 1} signals in last 24h; count=${Math.floor(entry.value ?? 0)})`;
    }
    const valuePart = typeof entry.value === 'number' ? ` value=${entry.value.toFixed(4)}` : '';
    const thresholdPart = typeof entry.threshold === 'number' ? ` thr=${entry.threshold}` : '';
    return `${entry.code}${valuePart}${thresholdPart}`;
  }

  private buildEmptySymbolState(symbol: string): SymbolRuntimeState {
    return {
      symbol,
      fsmState: 'IDLE',
      baseline: null,
      holdStartTs: null,
      signalEvents: [],
      lastSignalBucketKey: null,
      signalEvents24h: [],
      lastSignalBucketStart: null,
      prevCandleOi: null,
      lastCandleOi: null,
      prevCandleMark: null,
      lastCandleMark: null,
      lastCandleBucketStart: null,
      lastEvaluationGateTs: null,
      blockedUntilTs: 0,
      overrideGateOnce: false,
      pendingOrder: null,
      position: null,
      demo: null,
      trendCandles5m: [],
      trendCandles15m: [],
      oiCandleDeltaPctHistory: [],
      armedSignal: null,
      noEntryReasonCounts: new Map(),
      lastNoEntryReasons: [],
      entryReason: null,
      lastPriceDeltaPct: null,
      lastOiDeltaPct: null,
      lastSignalCount24h: 0,
      gates: null,
      lastBothCandidate: null
    };
  }

  private placeConfirmedOrder(symbolState: SymbolRuntimeState, marketState: MarketState, side: 'LONG' | 'SHORT', qty: number): void {
    if (!this.state.config) {
      return;
    }

    const now = this.now();
    const orderSide = side === 'LONG' ? 'Buy' : 'Sell';
    const off = Math.max(0, this.state.config.entryOffsetPct ?? DEFAULT_ENTRY_OFFSET_PCT);
    const entryOffsetFraction = percentToFraction(off);
    const unroundedEntryLimit = side === 'LONG' ? marketState.markPrice * (1 - entryOffsetFraction) : marketState.markPrice * (1 + entryOffsetFraction);
    const entryLimit = this.roundPriceLikeMark(unroundedEntryLimit, marketState.markPrice);
    const tpMovePct = percentToFraction(this.state.config.tpRoiPct / this.state.config.leverage);
    const slMovePct = percentToFraction(this.state.config.slRoiPct / this.state.config.leverage);

    const pendingOrder: PaperPendingOrder = {
      symbol: symbolState.symbol,
      side: orderSide,
      limitPrice: entryLimit,
      qty,
      markAtSignal: marketState.markPrice,
      entryOffsetPct: off,
      spreadBpsAtEntry: marketState.spreadBps ?? null,
      placedTs: now,
      expiresTs: now + ONE_HOUR_MS,
      tpPrice: side === 'LONG' ? entryLimit * (1 + tpMovePct) : entryLimit * (1 - tpMovePct),
      slPrice: side === 'LONG' ? entryLimit * (1 - slMovePct) : entryLimit * (1 + slMovePct),
      orderLinkId: `${symbolState.symbol}-${now}`,
      sentToExchange: this.state.config.mode === 'paper'
    };

    if (!Number.isFinite(pendingOrder.limitPrice) || pendingOrder.limitPrice <= 0 || !Number.isFinite(pendingOrder.qty) || pendingOrder.qty <= 0) {
      this.recordNoEntryReason(symbolState, {
        code: 'INVALID_ENTRY_PAYLOAD',
        message: 'Refused to open entry with invalid price/qty.'
      });
      this.deps.emitLog?.(`Skipped ${symbolState.symbol}: invalid entry payload (price=${pendingOrder.limitPrice}, qty=${pendingOrder.qty}).`);
      this.resetToIdle(symbolState);
      return;
    }

    if (this.state.config.mode === 'demo' && !this.isValidDemoOrderPayload(symbolState.symbol, pendingOrder)) {
      this.recordNoEntryReason(symbolState, {
        code: 'INVALID_DEMO_ORDER_PAYLOAD',
        message: 'Refused demo entry: invalid order payload.'
      });
      this.deps.emitLog?.(`Skipped ${symbolState.symbol}: invalid demo order payload (limit=${pendingOrder.limitPrice}, qty=${pendingOrder.qty}).`);
      this.resetToIdle(symbolState);
      return;
    }

    symbolState.pendingOrder = pendingOrder;
    symbolState.fsmState = 'ENTRY_PENDING';
    symbolState.holdStartTs = null;
    symbolState.demo =
      this.state.config.mode === 'demo'
        ? {
            orderId: null,
            orderLinkId: pendingOrder.orderLinkId ?? null,
            placedTs: pendingOrder.placedTs,
            expiresTs: pendingOrder.expiresTs
          }
        : null;

    this.lastEntryPlacedTs = now;

    if (this.state.config.mode === 'paper') {
      this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'PLACED', order: pendingOrder });
      this.persistSnapshot();
      return;
    }

    this.demoQueue.enqueue({
      symbol: symbolState.symbol,
      execute: async () => {
        if (!this.deps.demoTradeClient || !symbolState.pendingOrder) {
          return;
        }

        const created = await this.deps.demoTradeClient.createLimitOrderWithTpSl({
          symbol: symbolState.symbol,
          side: pendingOrder.side,
          qty: String(pendingOrder.qty),
          price: String(pendingOrder.limitPrice),
          orderLinkId: pendingOrder.orderLinkId ?? `${symbolState.symbol}-${pendingOrder.placedTs}`,
          takeProfit: String(pendingOrder.tpPrice),
          stopLoss: String(pendingOrder.slPrice)
        });

        const currentOrder = symbolState.pendingOrder;
        if (!currentOrder) {
          return;
        }

        currentOrder.orderId = created.orderId;
        currentOrder.orderLinkId = created.orderLinkId;
        currentOrder.sentToExchange = true;
        symbolState.demo = {
          orderId: created.orderId,
          orderLinkId: created.orderLinkId,
          placedTs: currentOrder.placedTs,
          expiresTs: currentOrder.expiresTs
        };
        this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'PLACED', order: { ...currentOrder } });
        this.persistSnapshot();
      }
    });
  }


  private isValidDemoOrderPayload(symbol: string, pendingOrder: PaperPendingOrder): boolean {
    if (!symbol || !symbol.endsWith('USDT')) {
      return false;
    }

    if (!Number.isFinite(pendingOrder.limitPrice) || pendingOrder.limitPrice <= 0) {
      return false;
    }

    if (!Number.isFinite(pendingOrder.qty) || pendingOrder.qty <= 0) {
      return false;
    }

    const lotSize = this.lotSizeBySymbol.get(symbol);
    if (!lotSize || lotSize.qtyStep === null || lotSize.minOrderQty === null) {
      return true;
    }

    const normalizedQty = normalizeQty(pendingOrder.qty, lotSize.qtyStep, lotSize.minOrderQty, lotSize.maxOrderQty);
    return normalizedQty !== null && normalizedQty > 0;
  }

  private async processDemoEntryPending(symbolState: SymbolRuntimeState, marketState: MarketState, openOrders: DemoOpenOrder[]): Promise<void> {
    const pendingOrder = symbolState.pendingOrder;
    if (!pendingOrder) {
      return;
    }

    const now = this.now();
    if (now >= pendingOrder.expiresTs) {
      await this.cancelSymbolPendingOrder(symbolState, marketState, 'EXPIRED');
      return;
    }

    const matchingOrder = openOrders.find((order) => {
      if (order.symbol !== symbolState.symbol) {
        return false;
      }

      if (pendingOrder.orderId && order.orderId === pendingOrder.orderId) {
        return true;
      }

      return !!pendingOrder.orderLinkId && order.orderLinkId === pendingOrder.orderLinkId;
    });

    if (!matchingOrder) {
      return;
    }

    if (matchingOrder.orderStatus === 'Filled') {
      const side = pendingOrder.side === 'Buy' ? 'LONG' : 'SHORT';
      const position: PaperPosition = {
        symbol: symbolState.symbol,
        side,
        entryPrice: pendingOrder.limitPrice,
        markAtSignal: pendingOrder.markAtSignal,
        entryLimit: pendingOrder.limitPrice,
        entryOffsetPct: pendingOrder.entryOffsetPct,
        entrySlippageBpsApplied: 0,
        spreadBpsAtEntry: pendingOrder.spreadBpsAtEntry,
        qty: pendingOrder.qty,
        tpPrice: pendingOrder.tpPrice ?? pendingOrder.limitPrice,
        slPrice: pendingOrder.slPrice ?? pendingOrder.limitPrice,
        openedTs: this.now()
      };

      symbolState.pendingOrder = null;
      symbolState.demo = null;
      symbolState.position = position;
      symbolState.fsmState = 'POSITION_OPEN';
      this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'FILLED', order: pendingOrder });
      this.deps.emitPositionUpdate({ symbol: symbolState.symbol, status: 'OPEN', position });
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    if (matchingOrder.orderStatus === 'Cancelled' || matchingOrder.orderStatus === 'Rejected') {
      symbolState.pendingOrder = null;
      symbolState.demo = null;
      symbolState.fsmState = 'IDLE';
      this.resetBaseline(symbolState, marketState);
      this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'CANCELLED', order: pendingOrder });
      this.updateSummaryCounts();
      this.persistSnapshot();
    }
  }



  private async processDemoOpenPosition(symbolState: SymbolRuntimeState, marketState: MarketState, position: DemoPosition | null): Promise<void> {
    if (!symbolState.position) {
      return;
    }

    if (position && Number.isFinite(position.size) && position.size > 0) {
      return;
    }

    const closedPosition: PaperPosition = {
      ...symbolState.position,
      entryPrice:
        position && position.entryPrice !== null && Number.isFinite(position.entryPrice) ? position.entryPrice : symbolState.position.entryPrice
    };

    const closedPnl = await this.loadDemoClosedPnlBestEffort(symbolState.symbol);
    const matchedClosedPnl = this.matchDemoClosedPnl(symbolState.position, closedPnl, symbolState.symbol);
    const exitPrice =
      matchedClosedPnl && typeof matchedClosedPnl.avgExitPrice === 'number' && Number.isFinite(matchedClosedPnl.avgExitPrice)
        ? matchedClosedPnl.avgExitPrice
        : marketState.markPrice;
    const closeReason = this.resolveCloseReason(symbolState.position, exitPrice);
    const entryFeeRate = PAPER_FEES.makerFeeRate;
    const exitFeeRate = PAPER_FEES.takerFeeRate;
    const {
      grossPnlUSDT: grossPnl,
      entryFeeUSDT,
      exitFeeUSDT,
      feeTotalUSDT,
      netPnlUSDT
    } = computePnlBreakdown({
      side: symbolState.position.side,
      qty: symbolState.position.qty,
      entryPrice: symbolState.position.entryPrice,
      exitPrice,
      entryFeeRate,
      exitFeeRate,
      slippageUSDT: null
    });

    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position: closedPosition,
      exitPrice,
      pnlUSDT: netPnlUSDT,
      closeReason,
      realizedGrossPnlUSDT: grossPnl,
      feesUSDT: feeTotalUSDT,
      realizedNetPnlUSDT: netPnlUSDT,
      entryFeeUSDT,
      exitFeeUSDT,
      entryFeeRate,
      exitFeeRate,
      entry: {
        markAtSignal: closedPosition.markAtSignal,
        entryLimit: closedPosition.entryLimit,
        fillPrice: closedPosition.entryPrice,
        entryOffsetPct: closedPosition.entryOffsetPct,
        slippageBpsApplied: closedPosition.entrySlippageBpsApplied ?? 0,
        spreadBpsAtEntry: closedPosition.spreadBpsAtEntry ?? null
      },
      exit: {
        tpPrice: closedPosition.tpPrice,
        slPrice: closedPosition.slPrice,
        closePrice: exitPrice,
        slippageBpsApplied: 0,
        spreadBpsAtExit: marketState.spreadBps ?? null
      },
      impact: {
        grossPnlUSDT: grossPnl,
        feesUSDT: feeTotalUSDT,
        slippageUSDT: null,
        netPnlUSDT
      }
    });
    this.recordClosedTrade(
      symbolState.symbol,
      closedPosition.side,
      grossPnl,
      feeTotalUSDT,
      netPnlUSDT,
      closeReason,
      entryFeeUSDT,
      exitFeeUSDT,
      closedPosition.openedTs,
      null,
      closedPosition.spreadBpsAtEntry ?? null,
      marketState.spreadBps ?? null,
      {
        markAtSignal: closedPosition.markAtSignal,
        entryLimit: closedPosition.entryLimit,
        fillPrice: closedPosition.entryPrice,
        entryOffsetPct: closedPosition.entryOffsetPct,
        slippageBpsApplied: closedPosition.entrySlippageBpsApplied ?? 0,
        spreadBpsAtEntry: closedPosition.spreadBpsAtEntry ?? null
      },
      {
        tpPrice: closedPosition.tpPrice,
        slPrice: closedPosition.slPrice,
        closePrice: exitPrice,
        slippageBpsApplied: 0,
        spreadBpsAtExit: marketState.spreadBps ?? null
      }
    );
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  private async loadDemoClosedPnlBestEffort(symbol: string): Promise<DemoClosedPnlItem[]> {
    if (!this.deps.demoTradeClient || this.state.config?.mode !== 'demo') {
      return [];
    }

    try {
      return await this.deps.demoTradeClient.getClosedPnl({ symbol, limit: 3 });
    } catch {
      return [];
    }
  }

  private matchDemoClosedPnl(position: PaperPosition, closedList: DemoClosedPnlItem[], symbol: string): DemoClosedPnlItem | null {
    const expectedSide = position.side === 'LONG' ? 'Buy' : 'Sell';
    const qtyStep = this.lotSizeBySymbol.get(symbol)?.qtyStep ?? null;
    const qtyTolerance = Math.max(typeof qtyStep === 'number' && Number.isFinite(qtyStep) ? qtyStep : 0, position.qty * 0.02);
    for (const item of closedList) {
      const ts = item.updatedTime ?? item.createdTime;
      if (
        item.symbol === position.symbol &&
        item.side === expectedSide &&
        Math.abs(item.qty - position.qty) <= qtyTolerance &&
        typeof ts === 'number' &&
        ts >= position.openedTs - 60_000
      ) {
        return item;
      }
    }

    return null;
  }

  private resolveCloseReason(position: PaperPosition, exitPrice: number): TradeCloseReason {
    if (position.closeReason === 'KILL') {
      return 'KILL';
    }

    const tolerance = Math.max(position.entryPrice * 0.001, 0.00000001);
    if (position.side === 'LONG') {
      if (exitPrice >= position.tpPrice - tolerance) {
        return 'TP';
      }
      if (exitPrice <= position.slPrice + tolerance) {
        return 'SL';
      }
      return 'MANUAL';
    }

    if (exitPrice <= position.tpPrice + tolerance) {
      return 'TP';
    }
    if (exitPrice >= position.slPrice - tolerance) {
      return 'SL';
    }
    return 'MANUAL';
  }

  private processPendingPaperOrder(symbolState: SymbolRuntimeState, marketState: MarketState): void {
    if (!symbolState.pendingOrder || !this.state.config) {
      return;
    }

    const now = this.now();
    if (now >= symbolState.pendingOrder.expiresTs) {
      const expiredOrder = symbolState.pendingOrder;
      symbolState.pendingOrder = null;
      symbolState.fsmState = 'IDLE';
      this.resetBaseline(symbolState, marketState);
      this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'EXPIRED', order: expiredOrder });
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    const shouldFill =
      (symbolState.pendingOrder.side === 'Buy' && marketState.markPrice <= symbolState.pendingOrder.limitPrice) ||
      (symbolState.pendingOrder.side === 'Sell' && marketState.markPrice >= symbolState.pendingOrder.limitPrice);

    if (!shouldFill) {
      return;
    }

    const filledOrder = symbolState.pendingOrder;
    const side = filledOrder.side === 'Buy' ? 'LONG' : 'SHORT';
    const tpMovePct = percentToFraction(this.state.config.tpRoiPct / this.state.config.leverage);
    const slMovePct = percentToFraction(this.state.config.slRoiPct / this.state.config.leverage);

    const fillRatio = (this.state.config.paperPartialFillPct ?? DEFAULT_PAPER_PARTIAL_FILL_PCT) / 100;
    const filledQty = filledOrder.qty * fillRatio;
    if (filledQty <= 0) {
      return;
    }
    const entrySlippageFraction = (this.state.config.paperEntrySlippageBps ?? DEFAULT_PAPER_ENTRY_SLIPPAGE_BPS) / 10_000;
    const entrySlippageBpsApplied = this.state.config.paperEntrySlippageBps ?? DEFAULT_PAPER_ENTRY_SLIPPAGE_BPS;
    const entryPrice = side === 'LONG' ? filledOrder.limitPrice * (1 + entrySlippageFraction) : filledOrder.limitPrice * (1 - entrySlippageFraction);

    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(filledQty) || filledQty <= 0 || (side !== 'LONG' && side !== 'SHORT')) {
      this.recordNoEntryReason(symbolState, {
        code: 'INVALID_ENTRY_PAYLOAD',
        message: 'Paper fill rejected: invalid entryPrice/qty/side.'
      });
      this.deps.emitLog?.(`Skipped ${symbolState.symbol}: paper fill rejected due to invalid entry payload.`);
      symbolState.pendingOrder = null;
      symbolState.fsmState = 'IDLE';
      this.resetBaseline(symbolState, marketState);
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    const position: PaperPosition = {
      symbol: symbolState.symbol,
      side,
      entryPrice,
      markAtSignal: filledOrder.markAtSignal,
      entryLimit: filledOrder.limitPrice,
      entryOffsetPct: filledOrder.entryOffsetPct,
      entrySlippageBpsApplied,
      spreadBpsAtEntry: filledOrder.spreadBpsAtEntry,
      qty: filledQty,
      tpPrice: side === 'LONG' ? entryPrice * (1 + tpMovePct) : entryPrice * (1 - tpMovePct),
      slPrice: side === 'LONG' ? entryPrice * (1 - slMovePct) : entryPrice * (1 + slMovePct),
      openedTs: now
    };

    symbolState.pendingOrder = null;
    symbolState.position = position;
    symbolState.fsmState = 'POSITION_OPEN';

    this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'FILLED', order: filledOrder });
    this.deps.emitPositionUpdate({ symbol: symbolState.symbol, status: 'OPEN', position });
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  private processOpenPosition(symbolState: SymbolRuntimeState, marketState: MarketState): void {
    if (!symbolState.position) {
      return;
    }

    const position = symbolState.position;
    const longTpHit = position.side === 'LONG' && marketState.markPrice >= position.tpPrice;
    const longSlHit = position.side === 'LONG' && marketState.markPrice <= position.slPrice;
    const shortTpHit = position.side === 'SHORT' && marketState.markPrice <= position.tpPrice;
    const shortSlHit = position.side === 'SHORT' && marketState.markPrice >= position.slPrice;
    const tpHit = longTpHit || shortTpHit;
    const slHit = longSlHit || shortSlHit;

    if (!tpHit && !slHit) {
      return;
    }

    const closeReason: TradeCloseReason = slHit ? 'SL' : 'TP';
    const rawExitPrice = slHit ? position.slPrice : position.tpPrice;
    const exitSlippageFraction = (this.state.config?.paperExitSlippageBps ?? DEFAULT_PAPER_EXIT_SLIPPAGE_BPS) / 10_000;
    const exitSlippageBpsApplied = this.state.config?.paperExitSlippageBps ?? DEFAULT_PAPER_EXIT_SLIPPAGE_BPS;
    const exitPrice = position.side === 'LONG' ? rawExitPrice * (1 - exitSlippageFraction) : rawExitPrice * (1 + exitSlippageFraction);
    const slippageAbsPerUnitEntry = Math.abs(position.entryPrice - (position.entryLimit ?? position.entryPrice));
    const slippageAbsPerUnitExit = Math.abs(exitPrice - rawExitPrice);
    const slippageUSDT = (slippageAbsPerUnitEntry + slippageAbsPerUnitExit) * position.qty;
    // PAPER fee model: entry limit fills are treated as maker; TP/SL closes are taker for conservative expectancy.
    const entryFeeRate = PAPER_FEES.makerFeeRate;
    const exitFeeRate = PAPER_FEES.takerFeeRate;
    const {
      grossPnlUSDT: grossPnl,
      entryFeeUSDT,
      exitFeeUSDT,
      feeTotalUSDT,
      netPnlUSDT
    } = computePnlBreakdown({
      side: position.side,
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice,
      entryFeeRate,
      exitFeeRate,
      slippageUSDT
    });

    const closedPosition: PaperPosition = {
      ...position,
      closeReason,
      exitPrice,
      realizedGrossPnlUSDT: grossPnl,
      grossPnlUSDT: grossPnl,
      feesUSDT: feeTotalUSDT,
      entryFeeUSDT,
      exitFeeUSDT,
      feeTotalUSDT,
      realizedNetPnlUSDT: netPnlUSDT,
      netPnlUSDT,
      entryFeeRate,
      exitFeeRate,
      exitSlippageBpsApplied,
      spreadBpsAtExit: marketState.spreadBps ?? null,
      slippageUSDT,
      lastPnlUSDT: netPnlUSDT
    };

    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position: closedPosition,
      exitPrice,
      pnlUSDT: netPnlUSDT,
      closeReason,
      realizedGrossPnlUSDT: grossPnl,
      feesUSDT: feeTotalUSDT,
      realizedNetPnlUSDT: netPnlUSDT,
      entryFeeUSDT,
      exitFeeUSDT,
      entryFeeRate,
      exitFeeRate,
      entry: {
        markAtSignal: position.markAtSignal,
        entryLimit: position.entryLimit,
        fillPrice: position.entryPrice,
        entryOffsetPct: position.entryOffsetPct,
        slippageBpsApplied: position.entrySlippageBpsApplied,
        spreadBpsAtEntry: position.spreadBpsAtEntry ?? null
      },
      exit: {
        tpPrice: position.tpPrice,
        slPrice: position.slPrice,
        closePrice: exitPrice,
        slippageBpsApplied: exitSlippageBpsApplied,
        spreadBpsAtExit: marketState.spreadBps ?? null
      },
      impact: {
        grossPnlUSDT: grossPnl,
        feesUSDT: feeTotalUSDT,
        slippageUSDT,
        netPnlUSDT
      }
    });
    this.recordClosedTrade(
      symbolState.symbol,
      position.side,
      grossPnl,
      feeTotalUSDT,
      netPnlUSDT,
      closeReason,
      entryFeeUSDT,
      exitFeeUSDT,
      position.openedTs,
      slippageUSDT,
      position.spreadBpsAtEntry ?? null,
      marketState.spreadBps ?? null,
      {
        markAtSignal: position.markAtSignal,
        entryLimit: position.entryLimit,
        fillPrice: position.entryPrice,
        entryOffsetPct: position.entryOffsetPct,
        slippageBpsApplied: position.entrySlippageBpsApplied,
        spreadBpsAtEntry: position.spreadBpsAtEntry ?? null
      },
      {
        tpPrice: position.tpPrice,
        slPrice: position.slPrice,
        closePrice: exitPrice,
        slippageBpsApplied: exitSlippageBpsApplied,
        spreadBpsAtExit: marketState.spreadBps ?? null
      }
    );
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  private resetBaseline(symbolState: SymbolRuntimeState, marketState: MarketState): void {
    symbolState.baseline = {
      basePrice: marketState.markPrice,
      baseOiValue: marketState.openInterestValue,
      baseTs: marketState.ts
    };
    symbolState.overrideGateOnce = true;
    const bucketStart = this.computeTfBucketStart(this.now());
    symbolState.prevCandleOi = marketState.openInterestValue;
    symbolState.lastCandleOi = marketState.openInterestValue;
    symbolState.prevCandleMark = marketState.markPrice;
    symbolState.lastCandleMark = marketState.markPrice;
    symbolState.lastCandleBucketStart = bucketStart;
    this.persistSnapshot();
  }

  private updateSummaryCounts(): void {
    this.state = {
      ...this.state,
      ...this.getActivityMetrics()
    };
  }

  private getActiveSymbolsCount(): number {
    let count = 0;
    for (const symbolState of this.symbols.values()) {
      if (symbolState.fsmState === 'ENTRY_PENDING' || symbolState.fsmState === 'POSITION_OPEN') {
        count += 1;
      }
    }

    return count;
  }

  private persistSnapshot(): void {
    if (!this.deps.snapshotStore) {
      return;
    }

    const snapshot = this.buildSnapshot();
    const hasSymbols = Object.keys(snapshot.symbols).length > 0;
    if (!snapshot.config && !hasSymbols) {
      this.deps.snapshotStore.clear();
      this.state = {
        ...this.state,
        hasSnapshot: false
      };
      return;
    }

    this.deps.snapshotStore.save(snapshot);
    this.state = {
      ...this.state,
      hasSnapshot: true
    };
  }

  private buildSnapshot(): RuntimeSnapshot {
    const symbolSnapshots: Record<string, RuntimeSnapshotSymbol> = {};
    for (const [symbol, symbolState] of this.symbols.entries()) {
      if (symbolState.fsmState === 'IDLE' && !symbolState.pendingOrder && !symbolState.position && !symbolState.baseline) {
        continue;
      }

      symbolSnapshots[symbol] = {
        fsmState: symbolState.fsmState,
        baseline: symbolState.baseline,
        blockedUntilTs: symbolState.blockedUntilTs,
        overrideGateOnce: symbolState.overrideGateOnce,
        pendingOrder: symbolState.pendingOrder,
        position: symbolState.position,
        demo: symbolState.demo,
        signalEvents: symbolState.signalEvents,
        lastSignalBucketKey: symbolState.lastSignalBucketKey,
        signalEvents24h: symbolState.signalEvents24h,
        lastSignalBucketStart: symbolState.lastSignalBucketStart,
        prevCandleOi: symbolState.prevCandleOi,
        lastCandleOi: symbolState.lastCandleOi,
        prevCandleMark: symbolState.prevCandleMark,
        lastCandleMark: symbolState.lastCandleMark,
        lastCandleBucketStart: symbolState.lastCandleBucketStart,
        trend5mBucketStart: symbolState.trendCandles5m.at(-1)?.bucketStart ?? null,
        trend5mPrevClose: symbolState.trendCandles5m.at(-2)?.close ?? null,
        trend5mLastClose: symbolState.trendCandles5m.at(-1)?.close ?? null,
        trend15mBucketStart: symbolState.trendCandles15m.at(-1)?.bucketStart ?? null,
        trend15mPrevClose: symbolState.trendCandles15m.at(-2)?.close ?? null,
        trend15mLastClose: symbolState.trendCandles15m.at(-1)?.close ?? null,
        armedSignal: symbolState.armedSignal,
        lastNoEntryReasons: symbolState.lastNoEntryReasons,
        entryReason: symbolState.entryReason,
        lastPriceDeltaPct: symbolState.lastPriceDeltaPct,
        lastOiDeltaPct: symbolState.lastOiDeltaPct,
        lastSignalCount24h: symbolState.lastSignalCount24h,
        gates: symbolState.gates,
        lastBothCandidate: symbolState.lastBothCandidate
      };
    }

    return {
      savedAt: this.now(),
      paused: this.state.paused,
      running: this.state.running,
      runningSinceTs: this.state.runningSinceTs,
      activeUptimeMs: this.state.activeUptimeMs,
      config: this.state.config,
      symbols: symbolSnapshots,
      stats: this.getStats()
    };
  }

  private recordClosedTrade(
    symbol: string,
    side: 'LONG' | 'SHORT',
    grossPnlUSDT: number,
    feesUSDT: number,
    netPnlUSDT: number,
    reason: TradeCloseReason,
    entryFeeUSDT?: number,
    exitFeeUSDT?: number,
    positionOpenedTs?: number,
    slippageUSDT?: number | null,
    spreadBpsAtEntry?: number | null,
    spreadBpsAtExit?: number | null,
    entry?: PositionUpdatePayload['entry'],
    exit?: PositionUpdatePayload['exit']
  ): void {
    const now = this.now();
    this.rotateDailyPnlBucket();
    this.stats.totalTrades += 1;
    this.stats.pnlUSDT += netPnlUSDT;
    this.stats.todayPnlUSDT += netPnlUSDT;
    const normalizedSlippage = slippageUSDT ?? 0;
    this.stats.lastClosed = {
      ts: now,
      symbol,
      side,
      grossPnlUSDT,
      feesUSDT,
      netPnlUSDT,
      slippageUSDT: slippageUSDT ?? null,
      entry,
      exit,
      impact: { grossPnlUSDT, feesUSDT, slippageUSDT: slippageUSDT ?? null, netPnlUSDT },
      reason,
      entryFeeUSDT,
      exitFeeUSDT
    };
    this.stats.totalFeesUSDT += feesUSDT;
    this.stats.totalSlippageUSDT += normalizedSlippage;
    if (typeof spreadBpsAtEntry === 'number' && Number.isFinite(spreadBpsAtEntry)) {
      this.spreadEntryCount += 1;
      this.spreadEntrySumBps += spreadBpsAtEntry;
    }
    if (typeof spreadBpsAtExit === 'number' && Number.isFinite(spreadBpsAtExit)) {
      this.spreadExitCount += 1;
      this.spreadExitSumBps += spreadBpsAtExit;
    }
    this.stats.avgSpreadBpsEntry = this.spreadEntryCount > 0 ? this.spreadEntrySumBps / this.spreadEntryCount : null;
    this.stats.avgSpreadBpsExit = this.spreadExitCount > 0 ? this.spreadExitSumBps / this.spreadExitCount : null;

    if (netPnlUSDT > 0) {
      this.stats.wins += 1;
      this.winPnlSum += netPnlUSDT;
      this.stats.lossStreak = 0;
    } else if (netPnlUSDT < 0) {
      this.stats.losses += 1;
      this.lossPnlSum += netPnlUSDT;
      this.stats.lossStreak += 1;
    }

    this.stats.winratePct = this.stats.totalTrades > 0 ? (this.stats.wins / this.stats.totalTrades) * 100 : 0;
    this.stats.avgWinUSDT = this.stats.wins > 0 ? this.winPnlSum / this.stats.wins : null;
    this.stats.avgLossUSDT = this.stats.losses > 0 ? this.lossPnlSum / this.stats.losses : null;
    const winrateFraction = this.stats.winratePct / 100;
    this.stats.expectancyUSDT = this.stats.totalTrades > 0 ? winrateFraction * (this.stats.avgWinUSDT ?? 0) + (1 - winrateFraction) * (this.stats.avgLossUSDT ?? 0) : null;
    const sumWinsAbs = this.winPnlSum;
    const sumLossAbs = Math.abs(this.lossPnlSum);
    this.stats.profitFactor = this.stats.losses > 0 && sumLossAbs > 0 ? sumWinsAbs / sumLossAbs : null;
    this.stats.avgFeePerTradeUSDT = this.stats.totalTrades > 0 ? this.stats.totalFeesUSDT / this.stats.totalTrades : null;
    this.stats.avgNetPerTradeUSDT = this.stats.totalTrades > 0 ? this.stats.pnlUSDT / this.stats.totalTrades : null;
    const sideBucket = side === 'LONG' ? this.stats.long : this.stats.short;
    sideBucket.trades += 1;
    sideBucket.pnlUSDT += netPnlUSDT;
    if (netPnlUSDT > 0) {
      sideBucket.wins += 1;
    } else if (netPnlUSDT < 0) {
      sideBucket.losses += 1;
    }
    sideBucket.winratePct = sideBucket.trades > 0 ? (sideBucket.wins / sideBucket.trades) * 100 : 0;

    const perSymbol = this.getOrCreatePerSymbolStats(symbol);

    perSymbol.trades += 1;
    perSymbol.pnlUSDT += netPnlUSDT;
    perSymbol.lastClosedTs = now;
    perSymbol.lastClosedPnlUSDT = netPnlUSDT;
    const holdMs = Math.max(0, now - (positionOpenedTs ?? now));
    perSymbol.totalHoldMs += holdMs;
    perSymbol.closedTradesWithHold += 1;
    if (netPnlUSDT > 0) {
      perSymbol.wins += 1;
    } else if (netPnlUSDT < 0) {
      perSymbol.losses += 1;
    }

    if (side === 'LONG') {
      perSymbol.longTrades += 1;
      if (netPnlUSDT > 0) {
        perSymbol.longWins += 1;
      } else if (netPnlUSDT < 0) {
        perSymbol.longLosses += 1;
      }
    } else {
      perSymbol.shortTrades += 1;
      if (netPnlUSDT > 0) {
        perSymbol.shortWins += 1;
      } else if (netPnlUSDT < 0) {
        perSymbol.shortLosses += 1;
      }
    }

    this.perSymbolStats.set(symbol, perSymbol);
    this.closedTradesNetWindow.push(netPnlUSDT);
    if (this.closedTradesNetWindow.length > PNL_SANITY_WINDOW_TRADES) {
      this.closedTradesNetWindow.splice(0, this.closedTradesNetWindow.length - PNL_SANITY_WINDOW_TRADES);
    }
    this.maybeEmitPnlSanityWarning(now);

    const config = this.state.config;
    if (!config) {
      return;
    }

    if (config.dailyLossLimitUSDT > 0 && this.stats.todayPnlUSDT <= -config.dailyLossLimitUSDT) {
      this.pauseWithGuardrail('DAILY_LOSS_LIMIT');
      return;
    }

    if (config.maxConsecutiveLosses > 0 && this.stats.lossStreak >= config.maxConsecutiveLosses) {
      this.pauseWithGuardrail('MAX_CONSECUTIVE_LOSSES');
    }
  }

  private getOrCreatePerSymbolStats(symbol: string): BotPerSymbolAccumulator {
    const existing = this.perSymbolStats.get(symbol);
    if (existing) {
      return existing;
    }

    const created: BotPerSymbolAccumulator = {
      trades: 0,
      wins: 0,
      losses: 0,
      pnlUSDT: 0,
      longTrades: 0,
      longWins: 0,
      longLosses: 0,
      shortTrades: 0,
      shortWins: 0,
      shortLosses: 0,
      signalsAttempted: 0,
      signalsConfirmed: 0,
      confirmedBySide: { long: 0, short: 0 },
      confirmedByEntryReason: createEmptyReasonCounts(),
      totalHoldMs: 0,
      closedTradesWithHold: 0,
      lastClosedTs: null,
      lastClosedPnlUSDT: null
    };
    this.perSymbolStats.set(symbol, created);
    return created;
  }

  private rotateDailyPnlBucket(): void {
    const dayKey = new Date(this.now()).toISOString().slice(0, 10);
    if (this.todayPnlDayKey === dayKey) {
      return;
    }

    this.todayPnlDayKey = dayKey;
    this.stats.todayPnlUSDT = 0;
  }

  private maybeEmitPnlSanityWarning(now: number): void {
    if (this.closedTradesNetWindow.length < PNL_SANITY_WINDOW_TRADES) {
      return;
    }

    const wins = this.closedTradesNetWindow.filter((value) => value > 0).length;
    const winratePct = (wins / this.closedTradesNetWindow.length) * 100;
    const pnlUSDT = this.closedTradesNetWindow.reduce((sum, value) => sum + value, 0);
    if (winratePct > 55 && pnlUSDT < 0 && now - this.lastPnlSanityWarnTs >= 10_000) {
      this.deps.emitLog?.('PNL_SANITY: winrate high but net negative; check TP/SL ratio, fees, slippage, spread.');
      this.lastPnlSanityWarnTs = now;
    }
  }

  private pauseWithGuardrail(reason: string): void {
    this.finalizeActiveUptime();
    this.state = {
      ...this.state,
      paused: true,
      running: this.state.running,
      runningSinceTs: null
    };
    this.stats.guardrailPauseReason = reason;
    this.deps.emitLog?.(`Guardrail pause: ${reason}`);
    this.deps.onGuardrailPaused?.({ reason, stats: this.getStats(), state: this.getState() });
  }

  private finalizeActiveUptime(): void {
    if (this.state.runningSinceTs === null) {
      return;
    }

    const now = this.now();
    this.state = {
      ...this.state,
      activeUptimeMs: this.state.activeUptimeMs + Math.max(0, now - this.state.runningSinceTs)
    };
  }

  private async cancelSymbolPendingOrder(
    symbolState: SymbolRuntimeState,
    marketState: MarketState,
    status: 'CANCELLED' | 'EXPIRED'
  ): Promise<void> {
    if (!symbolState.pendingOrder) {
      return;
    }

    const cancelledOrder = symbolState.pendingOrder;
    if (this.state.config?.mode === 'demo') {
      const removed = this.demoQueue.removePendingJob(symbolState.symbol);
      if (!removed && cancelledOrder.sentToExchange && this.deps.demoTradeClient) {
        await this.deps.demoTradeClient.cancelOrder({
          symbol: symbolState.symbol,
          orderId: cancelledOrder.orderId,
          orderLinkId: cancelledOrder.orderLinkId
        });
      }
    }

    symbolState.pendingOrder = null;
    symbolState.demo = null;
    symbolState.fsmState = 'IDLE';
    symbolState.holdStartTs = null;
    this.resetBaseline(symbolState, marketState);
    this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status, order: cancelledOrder });
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  private roundQty(qty: number): number {
    return Math.round(qty * 1000) / 1000;
  }

  private roundPriceLikeMark(price: number, markPrice: number): number {
    if (!Number.isFinite(price)) {
      return markPrice;
    }

    const precision = Math.max(4, this.getDecimalPlaces(markPrice));
    return Number(price.toFixed(precision));
  }

  private getDecimalPlaces(value: number): number {
    if (!Number.isFinite(value)) {
      return 8;
    }

    const normalized = value.toString().toLowerCase();
    if (normalized.includes('e-')) {
      const exponent = Number(normalized.split('e-')[1]);
      return Number.isFinite(exponent) ? Math.min(8, Math.max(0, exponent)) : 8;
    }

    const decimalPart = normalized.split('.')[1] ?? '';
    return Math.min(8, Math.max(0, decimalPart.length));
  }

  private canEvaluateAtCurrentGate(symbolState: SymbolRuntimeState, now: number): boolean {
    if (symbolState.overrideGateOnce) {
      symbolState.overrideGateOnce = false;
      return true;
    }

    const boundaryTs = Math.floor(now / 60000) * 60000;
    const minute = new Date(boundaryTs).getUTCMinutes();
    if (minute % this.state.config!.tf !== 0) {
      return false;
    }

    if (symbolState.lastEvaluationGateTs === boundaryTs) {
      return false;
    }

    symbolState.lastEvaluationGateTs = boundaryTs;
    return true;
  }

  private getEligibleSignal(
    symbolState: SymbolRuntimeState,
    priceDeltaPct: number,
    oiDeltaPct: number
  ): { side: 'LONG' | 'SHORT'; entryReason: EntryReason; bothCandidate?: BothCandidateDiagnostics } | null {
    const direction = this.state.config!.direction;
    const longTrue = this.isLongConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);
    const shortDivergenceTrue = this.isShortDivergenceConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);
    const shortContinuationTrue = this.isShortContinuationConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);

    if (direction === 'both') {
      const shortEntryReason: EntryReason | null = shortDivergenceTrue ? 'SHORT_DIVERGENCE' : shortContinuationTrue ? 'SHORT_CONTINUATION' : null;
      const shortTrue = !!shortEntryReason;
      if (longTrue && shortTrue) {
        const tieBreak = this.state.config?.bothTieBreak ?? DEFAULT_BOTH_TIE_BREAK;
        if (tieBreak === 'longPriority') {
          return {
            side: 'LONG',
            entryReason: 'LONG_CONTINUATION',
            bothCandidate: { hadBoth: true, chosen: 'long', tieBreak }
          };
        }
        if (tieBreak === 'strongerSignal') {
          const edgeLong = this.computeLongEdge(priceDeltaPct, oiDeltaPct);
          const edgeShort = this.computeShortEdge(priceDeltaPct, oiDeltaPct);
          if (edgeLong > edgeShort + 1e-6) {
            return {
              side: 'LONG',
              entryReason: 'LONG_CONTINUATION',
              bothCandidate: { hadBoth: true, chosen: 'long', tieBreak, edgeLong, edgeShort }
            };
          }
          return {
            side: 'SHORT',
            entryReason: shortEntryReason,
            bothCandidate: { hadBoth: true, chosen: 'short', tieBreak, edgeLong, edgeShort }
          };
        }

        return {
          side: 'SHORT',
          entryReason: shortEntryReason,
          bothCandidate: { hadBoth: true, chosen: 'short', tieBreak }
        };
      }

      if (shortEntryReason) {
        return { side: 'SHORT', entryReason: shortEntryReason };
      }
      if (longTrue) {
        return { side: 'LONG', entryReason: 'LONG_CONTINUATION' };
      }
      return null;
    }

    if (direction === 'long') {
      return longTrue ? { side: 'LONG', entryReason: 'LONG_CONTINUATION' } : null;
    }

    if (shortDivergenceTrue) {
      return { side: 'SHORT', entryReason: 'SHORT_DIVERGENCE' };
    }

    return shortContinuationTrue ? { side: 'SHORT', entryReason: 'SHORT_CONTINUATION' } : null;
  }

  private computeLongEdge(priceDeltaPct: number, oiDeltaPct: number): number {
    const priceThr = Math.max(Math.abs(this.state.config!.priceUpThrPct), 1e-9);
    const oiThr = Math.max(Math.abs(this.state.config!.oiUpThrPct), 1e-9);
    return priceDeltaPct / priceThr + oiDeltaPct / oiThr;
  }

  private computeShortEdge(priceDeltaPct: number, oiDeltaPct: number): number {
    const priceThr = Math.max(Math.abs(this.state.config!.priceUpThrPct), 1e-9);
    const oiThr = Math.max(Math.abs(this.state.config!.oiUpThrPct), 1e-9);
    return Math.abs(priceDeltaPct) / priceThr + Math.abs(oiDeltaPct) / oiThr;
  }

  private isLongConditionTrue(symbolState: SymbolRuntimeState, priceDeltaPct: number, oiDeltaPct: number): boolean {
    return priceDeltaPct >= this.state.config!.priceUpThrPct && oiDeltaPct >= this.state.config!.oiUpThrPct && this.isLongOiCandleGateTrue(symbolState);
  }

  private isShortContinuationConditionTrue(symbolState: SymbolRuntimeState, priceDeltaPct: number, oiDeltaPct: number): boolean {
    return (
      priceDeltaPct <= -this.state.config!.priceUpThrPct &&
      oiDeltaPct <= -this.state.config!.oiUpThrPct &&
      this.isShortOiCandleGateTrue(symbolState)
    );
  }

  private isShortDivergenceConditionTrue(symbolState: SymbolRuntimeState, priceDeltaPct: number, oiDeltaPct: number): boolean {
    return (
      priceDeltaPct <= -this.state.config!.priceUpThrPct &&
      oiDeltaPct >= this.state.config!.oiUpThrPct &&
      this.isLongOiCandleGateTrue(symbolState)
    );
  }

  private isLongOiCandleGateTrue(symbolState: SymbolRuntimeState): boolean {
    const oiCandleThrPct = this.state.config!.oiCandleThrPct;
    if (oiCandleThrPct === 0) {
      return true;
    }

    const oiCandleDeltaPct = this.computeOiCandleDeltaPct(symbolState);
    if (oiCandleDeltaPct === null) {
      return true;
    }

    return oiCandleDeltaPct >= oiCandleThrPct;
  }

  private isShortOiCandleGateTrue(symbolState: SymbolRuntimeState): boolean {
    const oiCandleThrPct = this.state.config!.oiCandleThrPct;
    if (oiCandleThrPct === 0) {
      return true;
    }

    const oiCandleDeltaPct = this.computeOiCandleDeltaPct(symbolState);
    if (oiCandleDeltaPct === null) {
      return true;
    }

    return oiCandleDeltaPct <= -oiCandleThrPct;
  }

  private updateCandleOiState(symbolState: SymbolRuntimeState, oiValue: number, bucketStart: number, isNewBucket: boolean): void {
    if (symbolState.lastCandleBucketStart === null) {
      symbolState.lastCandleBucketStart = bucketStart;
      symbolState.prevCandleOi = oiValue;
      symbolState.lastCandleOi = oiValue;
      return;
    }

    if (isNewBucket) {
      symbolState.prevCandleOi = symbolState.lastCandleOi ?? oiValue;
      symbolState.lastCandleOi = oiValue;
      symbolState.lastCandleBucketStart = bucketStart;
      const deltaPct = this.computeOiCandleDeltaPct(symbolState);
      if (deltaPct !== null) {
        symbolState.oiCandleDeltaPctHistory.push(deltaPct);
        if (symbolState.oiCandleDeltaPctHistory.length > 5) {
          symbolState.oiCandleDeltaPctHistory.splice(0, symbolState.oiCandleDeltaPctHistory.length - 5);
        }
      }
      return;
    }

    symbolState.lastCandleOi = oiValue;
  }

  private updateCandlePriceState(symbolState: SymbolRuntimeState, markPrice: number, bucketStart: number, isNewBucket: boolean): void {
    if (symbolState.lastCandleBucketStart === null) {
      symbolState.lastCandleBucketStart = bucketStart;
      symbolState.prevCandleMark = markPrice;
      symbolState.lastCandleMark = markPrice;
      return;
    }

    if (isNewBucket) {
      symbolState.prevCandleMark = symbolState.lastCandleMark ?? markPrice;
      symbolState.lastCandleMark = markPrice;
      symbolState.lastCandleBucketStart = bucketStart;
      return;
    }

    symbolState.lastCandleMark = markPrice;
  }

  private computeOiCandleDeltaPct(symbolState: SymbolRuntimeState): number | null {
    if (!symbolState.prevCandleOi || !symbolState.lastCandleOi || symbolState.prevCandleOi <= 0 || symbolState.lastCandleOi <= 0) {
      return null;
    }

    return ((symbolState.lastCandleOi - symbolState.prevCandleOi) / symbolState.prevCandleOi) * 100;
  }

  private isOiTwoCandlesGateTrue(symbolState: SymbolRuntimeState, entryReason: EntryReason | null, side: 'LONG' | 'SHORT'): boolean {
    if (!this.state.config?.requireOiTwoCandles) {
      return true;
    }

    const threshold = this.state.config.oiCandleThrPct;
    if (threshold <= 0) {
      return true;
    }

    const recent = symbolState.oiCandleDeltaPctHistory.slice(-2);
    if (recent.length < 2) {
      return false;
    }

    if (side === 'LONG' || entryReason === 'SHORT_DIVERGENCE') {
      return recent.every((value) => value >= threshold);
    }

    return recent.every((value) => value <= -threshold);
  }

  getOiCandleSnapshot(symbol: string): {
    oiCandleValue: number | null;
    oiPrevCandleValue: number | null;
    oiCandleDeltaValue: number | null;
    oiCandleDeltaPct: number | null;
  } {
    const symbolState = this.symbols.get(symbol);
    if (!symbolState) {
      return {
        oiCandleValue: null,
        oiPrevCandleValue: null,
        oiCandleDeltaValue: null,
        oiCandleDeltaPct: null
      };
    }

    const oiCandleValue = symbolState.lastCandleOi;
    const oiPrevCandleValue = symbolState.prevCandleOi;
    const oiCandleDeltaValue =
      typeof oiCandleValue === 'number' && typeof oiPrevCandleValue === 'number' ? oiCandleValue - oiPrevCandleValue : null;
    const oiCandleDeltaPct = this.computeOiCandleDeltaPct(symbolState);

    return {
      oiCandleValue,
      oiPrevCandleValue,
      oiCandleDeltaValue,
      oiCandleDeltaPct
    };
  }

  private recordSignalEventAndGetCount(symbolState: SymbolRuntimeState, now: number): number {
    const cutoffTs = now - ONE_DAY_MS;
    symbolState.signalEvents = symbolState.signalEvents.filter((ts) => ts >= cutoffTs);
    symbolState.signalEvents24h = [...symbolState.signalEvents];
    const bucketStart = this.computeTfBucketStart(now);
    if (symbolState.lastSignalBucketKey !== bucketStart) {
      symbolState.signalEvents.push(now);
      symbolState.lastSignalBucketKey = bucketStart;
      symbolState.signalEvents24h = [...symbolState.signalEvents];
    }
    symbolState.lastSignalBucketStart = symbolState.lastSignalBucketKey;

    return symbolState.signalEvents.length;
  }

  private computeTfBucketStart(now: number): number {
    const tfMs = this.state.config!.tf * 60_000;
    return Math.floor(now / tfMs) * tfMs;
  }

  private computeDeltas(symbolState: SymbolRuntimeState, marketState: MarketState): { priceDeltaPct: number; oiDeltaPct: number } {
    const prevCandleMark = symbolState.prevCandleMark;
    const prevCandleOi = symbolState.prevCandleOi;

    if (!prevCandleMark || !prevCandleOi || prevCandleMark <= 0 || prevCandleOi <= 0) {
      return { priceDeltaPct: 0, oiDeltaPct: 0 };
    }
    return {
      priceDeltaPct: ((marketState.markPrice - prevCandleMark) / prevCandleMark) * 100,
      oiDeltaPct: ((marketState.openInterestValue - prevCandleOi) / prevCandleOi) * 100
    };
  }

  private resetToIdle(symbolState: SymbolRuntimeState): void {
    symbolState.fsmState = 'IDLE';
    symbolState.holdStartTs = null;
  }

  private enforceStateInvariant(symbolState: SymbolRuntimeState, context: string, marketState: MarketState): boolean {
    const isSignalState =
      symbolState.fsmState === 'HOLDING_LONG' ||
      symbolState.fsmState === 'HOLDING_SHORT' ||
      symbolState.fsmState === 'ARMED_LONG' ||
      symbolState.fsmState === 'ARMED_SHORT';
    const invariantHolds =
      (isSignalState && !symbolState.pendingOrder && !symbolState.position) ||
      (symbolState.fsmState === 'ENTRY_PENDING' && !!symbolState.pendingOrder && !symbolState.position) ||
      (symbolState.fsmState === 'POSITION_OPEN' && !!symbolState.position) ||
      (symbolState.fsmState === 'IDLE');
    if (invariantHolds) {
      return true;
    }

    this.deps.emitLog?.(
      `FSM invariant violated (${context}) for ${symbolState.symbol}: state=${symbolState.fsmState}, pendingOrder=${symbolState.pendingOrder ? 'yes' : 'no'}, position=${symbolState.position ? 'yes' : 'no'}`
    );
    symbolState.pendingOrder = null;
    symbolState.position = null;
    symbolState.demo = null;
    symbolState.armedSignal = null;
    this.resetToIdle(symbolState);
    this.resetBaseline(symbolState, marketState);
    return false;
  }
}

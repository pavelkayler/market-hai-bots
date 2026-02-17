import type { DemoOpenOrder, DemoPosition, IDemoTradeClient } from '../bybit/demoTradeClient.js';
import type { MarketState } from '../market/marketHub.js';
import { DemoOrderQueue, type DemoQueueSnapshot } from './demoOrderQueue.js';
import { PAPER_FEES } from './paperFees.js';
import type { PaperPendingOrder, PaperPosition } from './paperTypes.js';
import type { RuntimeSnapshot, RuntimeSnapshotSymbol, SnapshotStore } from './snapshotStore.js';
import type { UniverseEntry } from '../types/universe.js';
import { normalizeQty } from '../utils/qty.js';

export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BotTf = 1 | 3 | 5;

export type BotConfig = {
  mode: BotMode;
  direction: BotDirection;
  tf: BotTf;
  /** @deprecated confirmation now uses signalCounterThreshold */
  holdSeconds: number;
  signalCounterThreshold: number;
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

type BotStatsSideBreakdown = {
  trades: number;
  wins: number;
  losses: number;
  winratePct: number;
  pnlUSDT: number;
};

export type SymbolFsmState = 'IDLE' | 'HOLDING_LONG' | 'HOLDING_SHORT' | 'ENTRY_PENDING' | 'POSITION_OPEN';

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
  prevCandleOi: number | null;
  lastCandleOi: number | null;
  lastCandleBucketStart: number | null;
  lastEvaluationGateTs: number | null;
  blockedUntilTs: number;
  overrideGateOnce: boolean;
  pendingOrder: PaperPendingOrder | null;
  position: PaperPosition | null;
  demo: DemoRuntimeState | null;
};

export type SignalPayload = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  markPrice: number;
  oiValue: number;
  priceDeltaPct: number;
  oiDeltaPct: number;
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
  lastClosed?: {
    ts: number;
    symbol: string;
    pnlUSDT: number;
  };
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
};

const DEFAULT_HOLD_SECONDS = 3;
const DEFAULT_SIGNAL_COUNTER_THRESHOLD = 2;
const DEFAULT_OI_UP_THR_PCT = 50;
const DEFAULT_OI_CANDLE_THR_PCT = 0;
const DEFAULT_MAX_ACTIVE_SYMBOLS = 5;
const DEFAULT_ENTRY_OFFSET_PCT = 0.01;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

const createEmptySideBreakdown = (): BotStatsSideBreakdown => ({
  trades: 0,
  wins: 0,
  losses: 0,
  winratePct: 0,
  pnlUSDT: 0
});

export const normalizeBotConfig = (raw: Record<string, unknown>): BotConfig | null => {
  const tf = raw.tf;
  const mode = raw.mode;
  const direction = raw.direction;

  if (mode !== 'paper' && mode !== 'demo') {
    return null;
  }

  if (direction !== 'long' && direction !== 'short' && direction !== 'both') {
    return null;
  }

  if (tf !== 1 && tf !== 3 && tf !== 5) {
    return null;
  }

  const holdSeconds = typeof raw.holdSeconds === 'number' && Number.isFinite(raw.holdSeconds) ? raw.holdSeconds : DEFAULT_HOLD_SECONDS;
  const signalCounterThreshold =
    typeof raw.signalCounterThreshold === 'number' && Number.isFinite(raw.signalCounterThreshold)
      ? Math.max(1, Math.floor(raw.signalCounterThreshold))
      : DEFAULT_SIGNAL_COUNTER_THRESHOLD;
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

  const numericFields = ['priceUpThrPct', 'marginUSDT', 'leverage', 'tpRoiPct', 'slRoiPct'] as const;
  for (const key of numericFields) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      return null;
    }
  }

  return {
    mode,
    direction,
    tf,
    holdSeconds,
    signalCounterThreshold,
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
    maxConsecutiveLosses
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
    short: createEmptySideBreakdown()
  };
  private winPnlSum = 0;
  private lossPnlSum = 0;
  private todayPnlDayKey: string | null = null;

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
    return { ...this.state, uptimeMs };
  }

  getRuntimeSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  getStats(): BotStats {
    const stats = {
      ...this.stats,
      long: { ...this.stats.long },
      short: { ...this.stats.short }
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
      short: createEmptySideBreakdown()
    };
    this.winPnlSum = 0;
    this.lossPnlSum = 0;
    this.todayPnlDayKey = null;
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
    this.state = {
      ...this.state,
      running: true,
      paused: false,
      startedAt: now,
      runningSinceTs: now,
      config
    };
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
        signalEvents: state.signalEvents ?? [],
        lastSignalBucketKey: state.lastSignalBucketKey ?? null,
        prevCandleOi: state.prevCandleOi ?? null,
        lastCandleOi: state.lastCandleOi ?? null,
        lastCandleBucketStart: state.lastCandleBucketStart ?? null,
        lastEvaluationGateTs: null,
        blockedUntilTs: state.blockedUntilTs,
        overrideGateOnce: state.overrideGateOnce,
        pendingOrder: state.pendingOrder,
        position: state.position,
        demo: state.demo
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
      config: snapshot.config
    };

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
        ...(snapshot.stats.lastClosed ? { lastClosed: snapshot.stats.lastClosed } : {})
      };
      this.winPnlSum = snapshot.stats.wins * (snapshot.stats.avgWinUSDT ?? 0);
      this.lossPnlSum = snapshot.stats.losses * (snapshot.stats.avgLossUSDT ?? 0);
      this.todayPnlDayKey = new Date(this.now()).toISOString().slice(0, 10);
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
      prevCandleOi: symbolState.prevCandleOi,
      lastCandleOi: symbolState.lastCandleOi,
      lastCandleBucketStart: symbolState.lastCandleBucketStart
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

  async killSwitch(getMarketState: (symbol: string) => MarketState | undefined): Promise<number> {
    let cancelled = 0;
    this.pauseWithGuardrail('KILL_SWITCH');

    for (const symbolState of this.symbols.values()) {
      if (symbolState.fsmState !== 'ENTRY_PENDING' || !symbolState.pendingOrder) {
        continue;
      }

      const marketState =
        getMarketState(symbolState.symbol) ?? {
          markPrice: symbolState.pendingOrder.limitPrice,
          openInterestValue: symbolState.baseline?.baseOiValue ?? 0,
          ts: this.now()
        };

      await this.cancelSymbolPendingOrder(symbolState, marketState, 'CANCELLED');
      cancelled += 1;
    }

    this.updateSummaryCounts();
    this.persistSnapshot();
    return cancelled;
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
        this.processDemoOpenPosition(symbolState, marketState, position);
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

    if (!symbolState.baseline) {
      this.resetBaseline(symbolState, marketState);
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    const now = this.now();

    if (symbolState.fsmState === 'ENTRY_PENDING') {
      if (this.state.config.mode === 'paper') {
        this.processPendingPaperOrder(symbolState, marketState);
      }
      return;
    }

    if (symbolState.fsmState === 'POSITION_OPEN') {
      if (this.state.config.mode === 'paper') {
        this.processOpenPosition(symbolState, marketState);
      }
      return;
    }

    if (!this.state.running || this.state.paused) {
      return;
    }

    if (now < symbolState.blockedUntilTs) {
      return;
    }

    if (!this.canEvaluateAtCurrentGate(symbolState, now)) {
      return;
    }

    this.updateCandleOiState(symbolState, marketState.openInterestValue, now);
    const { priceDeltaPct, oiDeltaPct } = this.computeDeltas(symbolState.baseline, marketState);
    const side = this.getEligibleSide(symbolState, priceDeltaPct, oiDeltaPct);
    if (!side) {
      this.resetToIdle(symbolState);
      this.persistSnapshot();
      return;
    }

    const signalCount24h = this.recordSignalEventAndGetCount(symbolState, now);
    const confirmed = signalCount24h >= this.state.config.signalCounterThreshold;
    const holdingState = side === 'LONG' ? 'HOLDING_LONG' : 'HOLDING_SHORT';
    if (symbolState.fsmState !== holdingState) {
      symbolState.fsmState = holdingState;
      symbolState.holdStartTs = now;
    }

    if (!confirmed) {
      this.persistSnapshot();
      return;
    }

    this.deps.emitSignal({
      symbol,
      side,
      markPrice: marketState.markPrice,
      oiValue: marketState.openInterestValue,
      priceDeltaPct,
      oiDeltaPct
    });

    const leverage = this.state.config.leverage;
    const entryNotional = this.state.config.marginUSDT * leverage;
    const rawQty = entryNotional / marketState.markPrice;
    const lotSize = this.lotSizeBySymbol.get(symbolState.symbol);
    let qty: number | null;
    if (lotSize && lotSize.qtyStep !== null && lotSize.minOrderQty !== null) {
      qty = normalizeQty(rawQty, lotSize.qtyStep, lotSize.minOrderQty, lotSize.maxOrderQty);
    } else {
      qty = this.roundQty(rawQty);
    }

    if (qty === null || qty <= 0) {
      this.resetToIdle(symbolState);
      this.deps.emitLog?.(`Skipped ${symbolState.symbol}: qty below minOrderQty or invalid after lot-size normalization.`);
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    if (this.getActiveSymbolsCount() >= this.state.config.maxActiveSymbols) {
      this.resetToIdle(symbolState);
      this.deps.emitLog?.('Guardrail: maxActiveSymbols reached');
      this.updateSummaryCounts();
      this.persistSnapshot();
      return;
    }

    this.placeConfirmedOrder(symbolState, marketState, side, qty);
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  private buildEmptySymbolState(symbol: string): SymbolRuntimeState {
    return {
      symbol,
      fsmState: 'IDLE',
      baseline: null,
      holdStartTs: null,
      signalEvents: [],
      lastSignalBucketKey: null,
      prevCandleOi: null,
      lastCandleOi: null,
      lastCandleBucketStart: null,
      lastEvaluationGateTs: null,
      blockedUntilTs: 0,
      overrideGateOnce: false,
      pendingOrder: null,
      position: null,
      demo: null
    };
  }

  private placeConfirmedOrder(symbolState: SymbolRuntimeState, marketState: MarketState, side: 'LONG' | 'SHORT', qty: number): void {
    if (!this.state.config) {
      return;
    }

    const now = this.now();
    const orderSide = side === 'LONG' ? 'Buy' : 'Sell';
    const off = Math.max(0, this.state.config.entryOffsetPct ?? DEFAULT_ENTRY_OFFSET_PCT);
    const unroundedEntryLimit = side === 'LONG' ? marketState.markPrice * (1 - off / 100) : marketState.markPrice * (1 + off / 100);
    const entryLimit = this.roundPriceLikeMark(unroundedEntryLimit, marketState.markPrice);
    const tpMovePct = this.state.config.tpRoiPct / this.state.config.leverage;
    const slMovePct = this.state.config.slRoiPct / this.state.config.leverage;

    const pendingOrder: PaperPendingOrder = {
      symbol: symbolState.symbol,
      side: orderSide,
      limitPrice: entryLimit,
      qty,
      placedTs: now,
      expiresTs: now + ONE_HOUR_MS,
      tpPrice: side === 'LONG' ? marketState.markPrice * (1 + tpMovePct / 100) : marketState.markPrice * (1 - tpMovePct / 100),
      slPrice: side === 'LONG' ? marketState.markPrice * (1 - slMovePct / 100) : marketState.markPrice * (1 + slMovePct / 100),
      orderLinkId: `${symbolState.symbol}-${now}`,
      sentToExchange: this.state.config.mode === 'paper'
    };

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



  private processDemoOpenPosition(symbolState: SymbolRuntimeState, marketState: MarketState, position: DemoPosition | null): void {
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

    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position: closedPosition,
      exitPrice: marketState.markPrice,
      pnlUSDT: 0
    });
    this.recordClosedTrade(symbolState.symbol, closedPosition.side, 0);
    this.updateSummaryCounts();
    this.persistSnapshot();
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
    const tpMovePct = this.state.config.tpRoiPct / this.state.config.leverage;
    const slMovePct = this.state.config.slRoiPct / this.state.config.leverage;

    const position: PaperPosition = {
      symbol: symbolState.symbol,
      side,
      entryPrice: filledOrder.limitPrice,
      qty: filledOrder.qty,
      tpPrice: side === 'LONG' ? filledOrder.limitPrice * (1 + tpMovePct / 100) : filledOrder.limitPrice * (1 - tpMovePct / 100),
      slPrice: side === 'LONG' ? filledOrder.limitPrice * (1 - slMovePct / 100) : filledOrder.limitPrice * (1 + slMovePct / 100),
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
    const exitHit =
      (position.side === 'LONG' && (marketState.markPrice >= position.tpPrice || marketState.markPrice <= position.slPrice)) ||
      (position.side === 'SHORT' && (marketState.markPrice <= position.tpPrice || marketState.markPrice >= position.slPrice));

    if (!exitHit) {
      return;
    }

    const notional = position.entryPrice * position.qty;
    const grossPnl = position.side === 'LONG' ? (marketState.markPrice - position.entryPrice) * position.qty : (position.entryPrice - marketState.markPrice) * position.qty;
    const feePaid = notional * PAPER_FEES.makerFeeRate + marketState.markPrice * position.qty * PAPER_FEES.makerFeeRate;
    const pnlUSDT = grossPnl - feePaid;

    const closedPosition: PaperPosition = {
      ...position,
      lastPnlUSDT: pnlUSDT
    };

    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position: closedPosition,
      exitPrice: marketState.markPrice,
      pnlUSDT
    });
    this.recordClosedTrade(symbolState.symbol, position.side, pnlUSDT);
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
    symbolState.prevCandleOi = null;
    symbolState.lastCandleOi = marketState.openInterestValue;
    symbolState.lastCandleBucketStart = bucketStart;
    this.persistSnapshot();
  }

  private updateSummaryCounts(): void {
    let activeOrders = 0;
    let openPositions = 0;

    for (const symbolState of this.symbols.values()) {
      if (symbolState.pendingOrder) {
        activeOrders += 1;
      }
      if (symbolState.position) {
        openPositions += 1;
      }
    }

    this.state = {
      ...this.state,
      activeOrders,
      openPositions
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
        prevCandleOi: symbolState.prevCandleOi,
        lastCandleOi: symbolState.lastCandleOi,
        lastCandleBucketStart: symbolState.lastCandleBucketStart
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
      stats: this.stats
    };
  }

  private recordClosedTrade(symbol: string, side: 'LONG' | 'SHORT', pnlUSDT: number): void {
    this.rotateDailyPnlBucket();
    this.stats.totalTrades += 1;
    this.stats.pnlUSDT += pnlUSDT;
    this.stats.todayPnlUSDT += pnlUSDT;
    this.stats.lastClosed = { ts: this.now(), symbol, pnlUSDT };

    if (pnlUSDT > 0) {
      this.stats.wins += 1;
      this.winPnlSum += pnlUSDT;
      this.stats.lossStreak = 0;
    } else if (pnlUSDT < 0) {
      this.stats.losses += 1;
      this.lossPnlSum += pnlUSDT;
      this.stats.lossStreak += 1;
    }

    this.stats.winratePct = this.stats.totalTrades > 0 ? (this.stats.wins / this.stats.totalTrades) * 100 : 0;
    this.stats.avgWinUSDT = this.stats.wins > 0 ? this.winPnlSum / this.stats.wins : null;
    this.stats.avgLossUSDT = this.stats.losses > 0 ? this.lossPnlSum / this.stats.losses : null;
    const sideBucket = side === 'LONG' ? this.stats.long : this.stats.short;
    sideBucket.trades += 1;
    sideBucket.pnlUSDT += pnlUSDT;
    if (pnlUSDT > 0) {
      sideBucket.wins += 1;
    } else if (pnlUSDT < 0) {
      sideBucket.losses += 1;
    }
    sideBucket.winratePct = sideBucket.trades > 0 ? (sideBucket.wins / sideBucket.trades) * 100 : 0;

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

  private rotateDailyPnlBucket(): void {
    const dayKey = new Date(this.now()).toISOString().slice(0, 10);
    if (this.todayPnlDayKey === dayKey) {
      return;
    }

    this.todayPnlDayKey = dayKey;
    this.stats.todayPnlUSDT = 0;
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

  private getEligibleSide(symbolState: SymbolRuntimeState, priceDeltaPct: number, oiDeltaPct: number): 'LONG' | 'SHORT' | null {
    const direction = this.state.config!.direction;
    const longTrue = this.isLongConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);
    const shortDivergenceTrue = this.isShortDivergenceConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);
    const shortContinuationTrue = this.isShortContinuationConditionTrue(symbolState, priceDeltaPct, oiDeltaPct);

    if (direction === 'both') {
      if (shortDivergenceTrue || shortContinuationTrue) {
        return 'SHORT';
      }
      if (longTrue) {
        return 'LONG';
      }
      return null;
    }

    if (direction === 'long') {
      return longTrue ? 'LONG' : null;
    }

    return shortDivergenceTrue || shortContinuationTrue ? 'SHORT' : null;
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
      this.isShortOiCandleGateTrue(symbolState)
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

  private updateCandleOiState(symbolState: SymbolRuntimeState, oiValue: number, now: number): void {
    const bucketStart = this.computeTfBucketStart(now);
    if (symbolState.lastCandleBucketStart === null) {
      symbolState.lastCandleBucketStart = bucketStart;
      symbolState.lastCandleOi = oiValue;
      return;
    }

    if (symbolState.lastCandleBucketStart !== bucketStart) {
      symbolState.prevCandleOi = symbolState.lastCandleOi;
      symbolState.lastCandleOi = oiValue;
      symbolState.lastCandleBucketStart = bucketStart;
    }
  }

  private computeOiCandleDeltaPct(symbolState: SymbolRuntimeState): number | null {
    if (!symbolState.prevCandleOi || !symbolState.lastCandleOi || symbolState.prevCandleOi <= 0 || symbolState.lastCandleOi <= 0) {
      return null;
    }

    return ((symbolState.lastCandleOi - symbolState.prevCandleOi) / symbolState.prevCandleOi) * 100;
  }

  private recordSignalEventAndGetCount(symbolState: SymbolRuntimeState, now: number): number {
    const cutoffTs = now - ONE_DAY_MS;
    symbolState.signalEvents = symbolState.signalEvents.filter((ts) => ts >= cutoffTs);
    const bucketStart = this.computeTfBucketStart(now);
    if (symbolState.lastSignalBucketKey !== bucketStart) {
      symbolState.signalEvents.push(now);
      symbolState.lastSignalBucketKey = bucketStart;
    }

    return symbolState.signalEvents.length;
  }

  private computeTfBucketStart(now: number): number {
    const tfMs = this.state.config!.tf * 60_000;
    return Math.floor(now / tfMs) * tfMs;
  }

  private computeDeltas(baseline: SymbolBaseline, marketState: MarketState): { priceDeltaPct: number; oiDeltaPct: number } {
    return {
      priceDeltaPct: ((marketState.markPrice - baseline.basePrice) / baseline.basePrice) * 100,
      oiDeltaPct: ((marketState.openInterestValue - baseline.baseOiValue) / baseline.baseOiValue) * 100
    };
  }

  private resetToIdle(symbolState: SymbolRuntimeState): void {
    symbolState.fsmState = 'IDLE';
    symbolState.holdStartTs = null;
  }
}

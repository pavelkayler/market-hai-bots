import type { DemoOpenOrder, IDemoTradeClient } from '../bybit/demoTradeClient.js';
import type { MarketState } from '../market/marketHub.js';
import { DemoOrderQueue, type DemoQueueSnapshot } from './demoOrderQueue.js';
import { PAPER_FEES } from './paperFees.js';
import type { PaperPendingOrder, PaperPosition } from './paperTypes.js';
import type { RuntimeSnapshot, RuntimeSnapshotSymbol, SnapshotStore } from './snapshotStore.js';

export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BotTf = 1 | 3 | 5;

export type BotConfig = {
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
};

export type BotState = {
  running: boolean;
  paused: boolean;
  hasSnapshot: boolean;
  startedAt: number | null;
  config: BotConfig | null;
  queueDepth: number;
  activeOrders: number;
  openPositions: number;
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
  lastEvaluationGateTs: number | null;
  blockedUntilTs: number;
  overrideGateOnce: boolean;
  pendingOrder: PaperPendingOrder | null;
  position: PaperPosition | null;
  demo: DemoRuntimeState | null;
  demoNoOrderPolls: number;
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

type BotEngineDeps = {
  now?: () => number;
  emitSignal: (payload: SignalPayload) => void;
  emitOrderUpdate: (payload: OrderUpdatePayload) => void;
  emitPositionUpdate: (payload: PositionUpdatePayload) => void;
  emitQueueUpdate: (payload: DemoQueueSnapshot) => void;
  demoTradeClient?: IDemoTradeClient;
  snapshotStore?: SnapshotStore;
};

const DEFAULT_HOLD_SECONDS = 3;
const DEFAULT_OI_UP_THR_PCT = 50;
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEMO_CLOSE_NO_ORDER_POLLS = 3;

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
  const oiUpThrPct = typeof raw.oiUpThrPct === 'number' && Number.isFinite(raw.oiUpThrPct) ? raw.oiUpThrPct : DEFAULT_OI_UP_THR_PCT;

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
    priceUpThrPct: raw.priceUpThrPct as number,
    oiUpThrPct,
    marginUSDT: raw.marginUSDT as number,
    leverage: raw.leverage as number,
    tpRoiPct: raw.tpRoiPct as number,
    slRoiPct: raw.slRoiPct as number
  };
};

export class BotEngine {
  private readonly now: () => number;
  private readonly symbols = new Map<string, SymbolRuntimeState>();
  private readonly demoQueue: DemoOrderQueue;
  private state: BotState = {
    running: false,
    paused: false,
    hasSnapshot: false,
    startedAt: null,
    config: null,
    queueDepth: 0,
    activeOrders: 0,
    openPositions: 0
  };

  constructor(private readonly deps: BotEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.demoQueue = new DemoOrderQueue((snapshot) => {
      this.state = { ...this.state, queueDepth: snapshot.depth };
      this.deps.emitQueueUpdate(snapshot);
      this.persistSnapshot();
    });
  }

  getState(): BotState {
    return { ...this.state };
  }

  getRuntimeSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  setUniverseSymbols(symbols: string[]): void {
    const symbolSet = new Set(symbols);
    for (const symbol of this.symbols.keys()) {
      if (!symbolSet.has(symbol)) {
        this.symbols.delete(symbol);
      }
    }

    for (const symbol of symbols) {
      if (!this.symbols.has(symbol)) {
        this.symbols.set(symbol, this.buildEmptySymbolState(symbol));
      }
    }
    this.updateSummaryCounts();
    this.persistSnapshot();
  }

  start(config: BotConfig): void {
    this.state = {
      ...this.state,
      running: true,
      paused: false,
      startedAt: this.now(),
      config
    };
    this.persistSnapshot();
  }

  stop(): void {
    this.state = {
      ...this.state,
      running: false,
      paused: false
    };
    this.persistSnapshot();
  }

  pause(): void {
    this.state = {
      ...this.state,
      paused: true
    };
    this.persistSnapshot();
  }

  resume(canRun: boolean): boolean {
    this.state = {
      ...this.state,
      paused: false,
      running: canRun ? true : this.state.running
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
        lastEvaluationGateTs: null,
        blockedUntilTs: state.blockedUntilTs,
        overrideGateOnce: state.overrideGateOnce,
        pendingOrder: state.pendingOrder,
        position: state.position,
        demo: state.demo,
        demoNoOrderPolls: 0
      });
    }

    this.state = {
      ...this.state,
      running: false,
      paused: true,
      hasSnapshot: true,
      startedAt: null,
      config: snapshot.config
    };

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
      demo: symbolState.demo ? { ...symbolState.demo } : null
    };
  }

  async cancelPendingOrder(symbol: string, marketState: MarketState): Promise<boolean> {
    const symbolState = this.symbols.get(symbol);
    if (!symbolState || !symbolState.pendingOrder || symbolState.fsmState !== 'ENTRY_PENDING') {
      return false;
    }

    const cancelledOrder = symbolState.pendingOrder;
    if (this.state.config?.mode === 'demo') {
      const removed = this.demoQueue.removePendingJob(symbol);
      if (!removed && cancelledOrder.sentToExchange && this.deps.demoTradeClient) {
        await this.deps.demoTradeClient.cancelOrder({
          symbol,
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
    this.deps.emitOrderUpdate({ symbol, status: 'CANCELLED', order: cancelledOrder });
    this.updateSummaryCounts();
    this.persistSnapshot();
    return true;
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

      const openOrders = await this.deps.demoTradeClient.getOpenOrders(symbolState.symbol);
      if (symbolState.fsmState === 'ENTRY_PENDING' && symbolState.pendingOrder) {
        await this.processDemoEntryPending(symbolState, marketState, openOrders);
      }

      if (symbolState.fsmState === 'POSITION_OPEN' && symbolState.position) {
        this.processDemoOpenPosition(symbolState, marketState, openOrders);
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

    const now = this.now();
    if (now < symbolState.blockedUntilTs) {
      return;
    }

    if (!this.canEvaluateAtCurrentGate(symbolState, now)) {
      return;
    }

    const { priceDeltaPct, oiDeltaPct } = this.computeDeltas(symbolState.baseline, marketState);
    const side = this.getEligibleSide(priceDeltaPct, oiDeltaPct);
    if (!side) {
      this.resetToIdle(symbolState);
      this.persistSnapshot();
      return;
    }

    const holdingState = side === 'LONG' ? 'HOLDING_LONG' : 'HOLDING_SHORT';
    if (symbolState.fsmState !== holdingState) {
      symbolState.fsmState = holdingState;
      symbolState.holdStartTs = now;
      this.persistSnapshot();
      return;
    }

    if (symbolState.holdStartTs === null) {
      symbolState.holdStartTs = now;
      return;
    }

    if (now - symbolState.holdStartTs < this.state.config.holdSeconds * 1000) {
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
    const qty = this.roundQty(entryNotional / marketState.markPrice);

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
      lastEvaluationGateTs: null,
      blockedUntilTs: 0,
      overrideGateOnce: false,
      pendingOrder: null,
      position: null,
      demo: null,
      demoNoOrderPolls: 0
    };
  }

  private placeConfirmedOrder(symbolState: SymbolRuntimeState, marketState: MarketState, side: 'LONG' | 'SHORT', qty: number): void {
    if (!this.state.config) {
      return;
    }

    const now = this.now();
    const orderSide = side === 'LONG' ? 'Buy' : 'Sell';
    const tpMovePct = this.state.config.tpRoiPct / this.state.config.leverage;
    const slMovePct = this.state.config.slRoiPct / this.state.config.leverage;

    const pendingOrder: PaperPendingOrder = {
      symbol: symbolState.symbol,
      side: orderSide,
      limitPrice: marketState.markPrice,
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
      if (pendingOrder.sentToExchange && this.deps.demoTradeClient) {
        await this.deps.demoTradeClient.cancelOrder({
          symbol: symbolState.symbol,
          orderId: pendingOrder.orderId,
          orderLinkId: pendingOrder.orderLinkId
        });
      }

      symbolState.pendingOrder = null;
      symbolState.demo = null;
      symbolState.fsmState = 'IDLE';
      this.resetBaseline(symbolState, marketState);
      this.deps.emitOrderUpdate({ symbol: symbolState.symbol, status: 'EXPIRED', order: pendingOrder });
      this.updateSummaryCounts();
      this.persistSnapshot();
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
      symbolState.demoNoOrderPolls = 0;
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

  private processDemoOpenPosition(symbolState: SymbolRuntimeState, marketState: MarketState, openOrders: DemoOpenOrder[]): void {
    if (!symbolState.position) {
      return;
    }

    const hasAnyOpenOrder = openOrders.some((order) => {
      if (order.symbol !== symbolState.symbol) {
        return false;
      }

      return order.orderStatus === 'New' || order.orderStatus === 'PartiallyFilled' || order.orderStatus === 'Untriggered';
    });

    if (hasAnyOpenOrder) {
      symbolState.demoNoOrderPolls = 0;
      return;
    }

    symbolState.demoNoOrderPolls += 1;
    if (symbolState.demoNoOrderPolls < DEMO_CLOSE_NO_ORDER_POLLS) {
      return;
    }

    const position = symbolState.position;
    symbolState.position = null;
    symbolState.fsmState = 'IDLE';
    symbolState.demoNoOrderPolls = 0;
    this.resetBaseline(symbolState, marketState);
    this.deps.emitPositionUpdate({
      symbol: symbolState.symbol,
      status: 'CLOSED',
      position,
      exitPrice: marketState.markPrice,
      pnlUSDT: 0
    });
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
        demo: symbolState.demo
      };
    }

    return {
      savedAt: this.now(),
      paused: this.state.paused,
      running: this.state.running,
      config: this.state.config,
      symbols: symbolSnapshots
    };
  }

  private roundQty(qty: number): number {
    return Math.round(qty * 1000) / 1000;
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

  private getEligibleSide(priceDeltaPct: number, oiDeltaPct: number): 'LONG' | 'SHORT' | null {
    const direction = this.state.config!.direction;
    const longTrue = this.isLongConditionTrue(priceDeltaPct, oiDeltaPct);
    const shortTrue = this.isShortConditionTrue(priceDeltaPct, oiDeltaPct);

    if (direction === 'both') {
      if (shortTrue) {
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

    return shortTrue ? 'SHORT' : null;
  }

  private isLongConditionTrue(priceDeltaPct: number, oiDeltaPct: number): boolean {
    return priceDeltaPct >= this.state.config!.priceUpThrPct && oiDeltaPct >= this.state.config!.oiUpThrPct;
  }

  private isShortConditionTrue(priceDeltaPct: number, oiDeltaPct: number): boolean {
    return priceDeltaPct < 0 && oiDeltaPct < 0;
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

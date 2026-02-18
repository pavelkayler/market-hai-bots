import type { BothCandidateDiagnostics, EntryReason, GateSnapshot, NoEntryReason, SymbolBaseline, SymbolFsmState } from '../bot/botEngine.js';
import type { PaperPendingOrder, PaperPosition } from '../bot/paperTypes.js';
import type { MarketState } from '../market/marketHub.js';

type WsClient = { send: (payload: string) => unknown };

type SymbolBroadcastPayload = {
  symbol: string;
  state: SymbolFsmState;
  markPrice: number;
  openInterestValue: number;
  oiCandleValue: number | null;
  oiPrevCandleValue: number | null;
  oiCandleDeltaValue: number | null;
  oiCandleDeltaPct: number | null;
  baseline: SymbolBaseline | null;
  pendingOrder: PaperPendingOrder | null;
  position: PaperPosition | null;
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

export type SymbolUpdateMode = 'single' | 'batch' | 'both';

type SymbolUpdateBroadcasterOptions = {
  mode?: SymbolUpdateMode;
  batchWindowMs?: number;
  batchMaxSymbols?: number;
  maxBufferedSymbols?: number;
  onFrameSent?: () => void;
};

export class SymbolUpdateBroadcaster {
  private readonly lastSentAtBySymbol = new Map<string, number>();
  private readonly pendingBatchBySymbol = new Map<string, SymbolBroadcastPayload>();
  private readonly pendingBatchOrder: string[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly mode: SymbolUpdateMode;
  private readonly batchWindowMs: number;
  private readonly batchMaxSymbols: number;
  private readonly maxBufferedSymbols: number;
  private readonly onFrameSent?: () => void;

  constructor(
    private readonly wsClients: Set<WsClient>,
    private readonly throttleMs: number,
    options: SymbolUpdateBroadcasterOptions = {}
  ) {
    this.mode = options.mode ?? 'single';
    this.batchWindowMs = options.batchWindowMs ?? 250;
    this.batchMaxSymbols = options.batchMaxSymbols ?? 50;
    this.maxBufferedSymbols = Math.max(options.maxBufferedSymbols ?? 500, 1);
    this.onFrameSent = options.onFrameSent;
  }

  setTrackedSymbols(symbols: string[]): void {
    const trackedSet = new Set(symbols);
    for (const symbol of this.lastSentAtBySymbol.keys()) {
      if (!trackedSet.has(symbol)) {
        this.lastSentAtBySymbol.delete(symbol);
        this.pendingBatchBySymbol.delete(symbol);
      }
    }

    for (const symbol of [...this.pendingBatchBySymbol.keys()]) {
      if (!trackedSet.has(symbol)) {
        this.pendingBatchBySymbol.delete(symbol);
      }
    }

    for (let index = this.pendingBatchOrder.length - 1; index >= 0; index -= 1) {
      if (!trackedSet.has(this.pendingBatchOrder[index])) {
        this.pendingBatchOrder.splice(index, 1);
      }
    }

    if (this.pendingBatchBySymbol.size === 0) {
      this.clearBatchTimer();
    }
  }

  broadcast(
    symbol: string,
    marketState: MarketState,
    state: SymbolFsmState,
    baseline: SymbolBaseline | null,
    pendingOrder: PaperPendingOrder | null,
    position: PaperPosition | null,
    oiCandle: {
      oiCandleValue: number | null;
      oiPrevCandleValue: number | null;
      oiCandleDeltaValue: number | null;
      oiCandleDeltaPct: number | null;
    } = {
      oiCandleValue: null,
      oiPrevCandleValue: null,
      oiCandleDeltaValue: null,
      oiCandleDeltaPct: null
    },
    topReasons: NoEntryReason[] = [],
    signalDiagnostics: {
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
    } = {}
  ): void {
    const now = Date.now();
    const lastSentAt = this.lastSentAtBySymbol.get(symbol) ?? 0;
    if (now - lastSentAt < this.throttleMs) {
      return;
    }

    this.lastSentAtBySymbol.set(symbol, now);

    const payload: SymbolBroadcastPayload = {
      symbol,
      state,
      markPrice: marketState.markPrice,
      openInterestValue: marketState.openInterestValue,
      oiCandleValue: oiCandle.oiCandleValue,
      oiPrevCandleValue: oiCandle.oiPrevCandleValue,
      oiCandleDeltaValue: oiCandle.oiCandleDeltaValue,
      oiCandleDeltaPct: oiCandle.oiCandleDeltaPct,
      baseline,
      pendingOrder,
      position,
      ...(topReasons.length > 0 ? { topReasons } : {}),
      ...(signalDiagnostics.entryReason !== undefined ? { entryReason: signalDiagnostics.entryReason } : {}),
      ...(signalDiagnostics.priceDeltaPct !== undefined ? { priceDeltaPct: signalDiagnostics.priceDeltaPct } : {}),
      ...(signalDiagnostics.oiDeltaPct !== undefined ? { oiDeltaPct: signalDiagnostics.oiDeltaPct } : {}),
      ...(signalDiagnostics.signalCount24h !== undefined ? { signalCount24h: signalDiagnostics.signalCount24h } : {}),
      ...(signalDiagnostics.signalCounterThreshold !== undefined ? { signalCounterThreshold: signalDiagnostics.signalCounterThreshold } : {}),
      ...(signalDiagnostics.signalCounterMin !== undefined ? { signalCounterMin: signalDiagnostics.signalCounterMin } : {}),
      ...(signalDiagnostics.signalCounterMax !== undefined ? { signalCounterMax: signalDiagnostics.signalCounterMax } : {}),
      ...(signalDiagnostics.signalCounterEligible !== undefined ? { signalCounterEligible: signalDiagnostics.signalCounterEligible } : {}),
      ...(signalDiagnostics.signalConfirmed !== undefined ? { signalConfirmed: signalDiagnostics.signalConfirmed } : {}),
      ...(signalDiagnostics.lastSignalAt !== undefined ? { lastSignalAt: signalDiagnostics.lastSignalAt } : {}),
      ...(signalDiagnostics.gates !== undefined && signalDiagnostics.gates !== null ? { gates: signalDiagnostics.gates } : {}),
      ...(signalDiagnostics.bothCandidate !== undefined && signalDiagnostics.bothCandidate !== null ? { bothCandidate: signalDiagnostics.bothCandidate } : {})
    };

    if (this.mode === 'single' || this.mode === 'both') {
      const envelope = JSON.stringify({
        type: 'symbol:update',
        ts: now,
        payload
      });

      for (const client of this.wsClients) {
        client.send(envelope);
        this.onFrameSent?.();
      }
    }

    if (this.mode === 'batch' || this.mode === 'both') {
      this.enqueueBatchPayload(symbol, payload, now);
    }
  }

  reset(): void {
    this.flushBatch();
    this.lastSentAtBySymbol.clear();
    this.pendingBatchBySymbol.clear();
    this.pendingBatchOrder.length = 0;
    this.clearBatchTimer();
  }

  private enqueueBatchPayload(symbol: string, payload: SymbolBroadcastPayload, now: number): void {
    if (!this.pendingBatchBySymbol.has(symbol)) {
      if (this.pendingBatchBySymbol.size >= this.maxBufferedSymbols) {
        const oldestSymbol = this.pendingBatchOrder.shift();
        if (oldestSymbol) {
          this.pendingBatchBySymbol.delete(oldestSymbol);
        }
      }

      this.pendingBatchOrder.push(symbol);
    }

    this.pendingBatchBySymbol.set(symbol, payload);

    if (this.pendingBatchBySymbol.size >= this.batchMaxSymbols) {
      this.flushBatch(now);
      return;
    }

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushBatch(Date.now());
      }, this.batchWindowMs);
    }
  }

  private flushBatch(ts: number = Date.now()): void {
    if (this.pendingBatchBySymbol.size === 0) {
      this.clearBatchTimer();
      return;
    }

    this.clearBatchTimer();

    const updates = this.pendingBatchOrder
      .map((symbol) => this.pendingBatchBySymbol.get(symbol))
      .filter((value): value is SymbolBroadcastPayload => !!value);

    this.pendingBatchBySymbol.clear();
    this.pendingBatchOrder.length = 0;

    if (updates.length === 0) {
      return;
    }

    const envelope = JSON.stringify({
      type: 'symbols:update',
      ts,
      payload: {
        updates
      }
    });

    for (const client of this.wsClients) {
      client.send(envelope);
      this.onFrameSent?.();
    }
  }

  private clearBatchTimer(): void {
    if (!this.batchTimer) {
      return;
    }

    clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }
}

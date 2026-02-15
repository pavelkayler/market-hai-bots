import type { SymbolBaseline, SymbolFsmState } from '../bot/botEngine.js';
import type { MarketState } from '../market/marketHub.js';

type WsClient = { send: (payload: string) => unknown };

type SymbolBroadcastPayload = {
  symbol: string;
  state: SymbolFsmState;
  markPrice: number;
  openInterestValue: number;
  baseline: SymbolBaseline | null;
  pendingOrder: null;
  position: null;
};

export class SymbolUpdateBroadcaster {
  private readonly lastSentAtBySymbol = new Map<string, number>();

  constructor(
    private readonly wsClients: Set<WsClient>,
    private readonly throttleMs: number
  ) {}

  broadcast(symbol: string, marketState: MarketState, state: SymbolFsmState, baseline: SymbolBaseline | null): void {
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
      baseline,
      pendingOrder: null,
      position: null
    };

    const envelope = JSON.stringify({
      type: 'symbol:update',
      ts: now,
      payload
    });

    for (const client of this.wsClients) {
      client.send(envelope);
    }
  }

  reset(): void {
    this.lastSentAtBySymbol.clear();
  }
}

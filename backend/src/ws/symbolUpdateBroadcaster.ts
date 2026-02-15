import type { MarketState } from '../market/marketHub.js';

type WsClient = { send: (payload: string) => unknown };

type SymbolBroadcastPayload = {
  symbol: string;
  state: 'IDLE';
  markPrice: number;
  openInterestValue: number;
  baseline: {
    basePrice: number;
    baseOiValue: number;
    baseTs: number;
  };
  pendingOrder: null;
  position: null;
};

export class SymbolUpdateBroadcaster {
  private readonly lastSentAtBySymbol = new Map<string, number>();

  constructor(
    private readonly wsClients: Set<WsClient>,
    private readonly throttleMs: number
  ) {}

  broadcast(symbol: string, marketState: MarketState): void {
    const now = Date.now();
    const lastSentAt = this.lastSentAtBySymbol.get(symbol) ?? 0;
    if (now - lastSentAt < this.throttleMs) {
      return;
    }

    this.lastSentAtBySymbol.set(symbol, now);

    const payload: SymbolBroadcastPayload = {
      symbol,
      state: 'IDLE',
      markPrice: marketState.markPrice,
      openInterestValue: marketState.openInterestValue,
      baseline: {
        basePrice: 0,
        baseOiValue: 0,
        baseTs: 0
      },
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

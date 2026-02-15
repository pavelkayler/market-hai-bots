import WebSocket from 'ws';

import type { TickerStream, TickerUpdate } from './tickerStream.js';

const BYBIT_PUBLIC_LINEAR_WS_URL = 'wss://stream.bybit.com/v5/public/linear';

const parseFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const parseTickerUpdate = (message: unknown): TickerUpdate | null => {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const packet = message as {
    topic?: unknown;
    data?: unknown;
    ts?: unknown;
  };

  if (typeof packet.topic !== 'string' || !packet.topic.startsWith('tickers.')) {
    return null;
  }

  const rawData = Array.isArray(packet.data) ? packet.data[0] : packet.data;
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }

  const data = rawData as {
    symbol?: unknown;
    markPrice?: unknown;
    openInterestValue?: unknown;
  };

  if (typeof data.symbol !== 'string') {
    return null;
  }

  const markPrice = parseFiniteNumber(data.markPrice);
  const openInterestValue = parseFiniteNumber(data.openInterestValue);
  const ts = parseFiniteNumber(packet.ts);

  if (markPrice === null || openInterestValue === null || ts === null) {
    return null;
  }

  return {
    symbol: data.symbol,
    markPrice,
    openInterestValue,
    ts
  };
};

export class RealBybitWsTickerStream implements TickerStream {
  private socket: WebSocket | null = null;
  private readonly tickerHandlers = new Set<(update: TickerUpdate) => void>();
  private readonly targetSymbols = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private started = false;

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.socket) {
      return;
    }

    const socketToClose = this.socket;
    this.socket = null;

    await new Promise<void>((resolve) => {
      socketToClose.once('close', () => resolve());
      socketToClose.close();
    });
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const next = new Set(symbols);
    const toSubscribe = [...next].filter((symbol) => !this.targetSymbols.has(symbol));
    const toUnsubscribe = [...this.targetSymbols].filter((symbol) => !next.has(symbol));

    this.targetSymbols.clear();
    for (const symbol of next) {
      this.targetSymbols.add(symbol);
    }

    if (!this.isSocketOpen()) {
      return;
    }

    if (toUnsubscribe.length > 0) {
      this.sendSubscription('unsubscribe', toUnsubscribe);
    }

    if (toSubscribe.length > 0) {
      this.sendSubscription('subscribe', toSubscribe);
    }
  }

  onTicker(handler: (update: TickerUpdate) => void): () => void {
    this.tickerHandlers.add(handler);
    return () => {
      this.tickerHandlers.delete(handler);
    };
  }

  private connect(): void {
    if (!this.started) {
      return;
    }

    const socket = new WebSocket(BYBIT_PUBLIC_LINEAR_WS_URL);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      if (this.targetSymbols.size > 0) {
        this.sendSubscription('subscribe', [...this.targetSymbols]);
      }
    });

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const update = parseTickerUpdate(parsed);
      if (!update) {
        return;
      }

      for (const handler of this.tickerHandlers) {
        handler(update);
      }
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      if (!this.started) {
        return;
      }

      this.scheduleReconnect();
    });

    socket.on('error', () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(5000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private sendSubscription(op: 'subscribe' | 'unsubscribe', symbols: string[]): void {
    if (!this.isSocketOpen() || symbols.length === 0) {
      return;
    }

    this.socket?.send(
      JSON.stringify({
        op,
        args: symbols.map((symbol) => `tickers.${symbol}`)
      })
    );
  }
}

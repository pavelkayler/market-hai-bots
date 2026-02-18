import WebSocket from 'ws';

import { parseWsTickerEvent } from '../bybit/parsers.js';
import type { TickerStream, TickerUpdate, TickerStreamStatus } from './tickerStream.js';

const BYBIT_PUBLIC_LINEAR_WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const PING_INTERVAL_MS = 15_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const STALE_MS = 30_000;
const STALE_TICKER_MS = 30_000;
const SUBSCRIPTION_CHUNK_SIZE = 15;
const SUBSCRIPTION_CHUNK_DELAY_MS = 75;

const parseTickerUpdate = (message: unknown): TickerUpdate | null => parseWsTickerEvent(message);

export const chunkSymbols = (symbols: string[], chunkSize = SUBSCRIPTION_CHUNK_SIZE): string[][] => {
  if (chunkSize <= 0) {
    return [symbols];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += chunkSize) {
    chunks.push(symbols.slice(index, index + chunkSize));
  }
  return chunks;
};

export const shouldForceReconnect = (params: {
  nowMs: number;
  lastMessageAt: number | null;
  lastTickerAt: number | null;
  staleMs?: number;
  staleTickerMs?: number;
}): boolean => {
  const staleMs = params.staleMs ?? STALE_MS;
  const staleTickerMs = params.staleTickerMs ?? STALE_TICKER_MS;
  if (params.lastMessageAt === null || params.lastTickerAt === null) {
    return false;
  }

  const messageAge = params.nowMs - params.lastMessageAt;
  const tickerAge = params.nowMs - params.lastTickerAt;
  return messageAge > staleMs || tickerAge > staleTickerMs;
};

const wait = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
};

export class RealBybitWsTickerStream implements TickerStream {
  private socket: WebSocket | null = null;
  private readonly tickerHandlers = new Set<(update: TickerUpdate) => void>();
  private readonly targetSymbols = new Set<string>();
  private readonly subscribedSymbols = new Set<string>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private started = false;
  private connected = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageAt: number | null = null;
  private lastTickerAt: number | null = null;
  private reconnectCount = 0;
  private lastError: string | null = null;

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.connect();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.clearReconnectTimer();
    this.clearIntervals();

    if (!this.socket) {
      this.connected = false;
      this.subscribedSymbols.clear();
      return;
    }

    const socketToClose = this.socket;
    this.socket = null;
    this.connected = false;
    this.subscribedSymbols.clear();

    await new Promise<void>((resolve) => {
      socketToClose.once('close', () => resolve());
      socketToClose.close();
    });
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const next = new Set(symbols);
    const changed = this.hasSymbolSetChanged(next);
    this.targetSymbols.clear();
    for (const symbol of next) {
      this.targetSymbols.add(symbol);
    }

    if (!this.isSocketOpen()) {
      return;
    }

    if (changed) {
      this.forceReconnect('symbol set changed');
    }
  }

  onTicker(handler: (update: TickerUpdate) => void): () => void {
    this.tickerHandlers.add(handler);
    return () => {
      this.tickerHandlers.delete(handler);
    };
  }

  getStatus(): TickerStreamStatus {
    return {
      running: this.started,
      connected: this.connected && this.isSocketOpen(),
      desiredSymbolsCount: this.targetSymbols.size,
      subscribedCount: this.subscribedSymbols.size,
      lastMessageAt: this.lastMessageAt,
      lastTickerAt: this.lastTickerAt,
      reconnectCount: this.reconnectCount,
      lastError: this.lastError
    };
  }

  private hasSymbolSetChanged(next: Set<string>): boolean {
    if (next.size !== this.targetSymbols.size) {
      return true;
    }

    for (const symbol of next) {
      if (!this.targetSymbols.has(symbol)) {
        return true;
      }
    }

    return false;
  }

  private connect(): void {
    if (!this.started) {
      return;
    }

    const socket = new WebSocket(BYBIT_PUBLIC_LINEAR_WS_URL);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.connected = true;
      const now = Date.now();
      this.lastMessageAt = now;
      this.lastTickerAt = now;
      this.lastError = null;
      this.startIntervals();
      void this.subscribeAllDesiredSymbols();
    });

    socket.on('message', (raw) => {
      this.lastMessageAt = Date.now();
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

      this.lastTickerAt = Date.now();
      this.subscribedSymbols.add(update.symbol);

      for (const handler of this.tickerHandlers) {
        handler(update);
      }
    });

    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.connected = false;
      this.clearIntervals();
      this.subscribedSymbols.clear();

      if (!this.started) {
        return;
      }

      this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      this.lastError = error.message;
      socket.close();
    });
  }

  private startIntervals(): void {
    this.clearIntervals();

    this.heartbeatTimer = setInterval(() => {
      if (!this.isSocketOpen()) {
        return;
      }

      this.socket?.send(JSON.stringify({ op: 'ping' }));
    }, PING_INTERVAL_MS);

    this.watchdogTimer = setInterval(() => {
      if (!this.started || !this.connected) {
        return;
      }

      const nowMs = Date.now();
      if (shouldForceReconnect({ nowMs, lastMessageAt: this.lastMessageAt, lastTickerAt: this.lastTickerAt })) {
        this.forceReconnect('watchdog stale stream');
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private clearIntervals(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private forceReconnect(reason: string): void {
    this.lastError = reason;
    this.reconnectCount += 1;
    this.clearIntervals();
    this.subscribedSymbols.clear();
    if (this.socket) {
      this.socket.terminate();
      this.socket = null;
    }

    this.connected = false;
    this.scheduleReconnect();
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

  private async subscribeAllDesiredSymbols(): Promise<void> {
    if (!this.isSocketOpen() || this.targetSymbols.size === 0) {
      return;
    }

    const chunks = chunkSymbols([...this.targetSymbols]);
    for (const chunk of chunks) {
      if (!this.isSocketOpen()) {
        return;
      }

      this.sendSubscription('subscribe', chunk);
      await wait(SUBSCRIPTION_CHUNK_DELAY_MS);
    }
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

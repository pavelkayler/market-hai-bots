import WebSocket from "ws";

/**
 * Backend ↔ Bybit WS client with:
 * - connection status
 * - JSON ping heartbeat
 * - auto-reconnect
 * - safe sendJson
 * - message routing via callback
 *
 * Public WS does not require auth.
 *
 * Docs:
 * - Connect + ping payload: {"op":"ping"} citeturn2view0
 * - Ticker topic: tickers.{symbol} citeturn1view0
 */

export type BybitConnStatus = "CONNECTED" | "DISCONNECTED";

export interface BybitWsClientOptions {
  url: string;
  pingIntervalMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export type BybitIncoming = any;

export class BybitWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private reconnectAttempt = 0;
  private stopped = false;

  public status: BybitConnStatus = "DISCONNECTED";

  constructor(
    private readonly opts: BybitWsClientOptions,
    private readonly onStatus: (s: BybitConnStatus) => void,
    private readonly onMessage?: (msg: BybitIncoming) => void,
    private readonly onOpen?: () => void
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.safeClose();
    this.setStatus("DISCONNECTED");
  }

  sendJson(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      this.opts.logger?.warn(`[bybit-ws] send failed: ${String((e as any)?.message ?? e)}`);
      return false;
    }
  }

  private connect() {
    if (this.stopped) return;

    this.safeClose();
    this.clearTimers();

    const { url } = this.opts;
    this.opts.logger?.info(`[bybit-ws] connecting: ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.opts.logger?.info("[bybit-ws] open");
      this.reconnectAttempt = 0;
      this.setStatus("CONNECTED");
      this.startPing();
      this.onOpen?.();
    });

    ws.on("message", (data) => {
      try {
        const txt = typeof data === "string" ? data : data.toString("utf-8");
        const msg = JSON.parse(txt);
        this.onMessage?.(msg);
      } catch {
        // ignore
      }
    });

    ws.on("close", (code, reason) => {
      this.opts.logger?.warn(`[bybit-ws] close code=${code} reason=${reason.toString()}`);
      this.setStatus("DISCONNECTED");
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.opts.logger?.error(`[bybit-ws] error: ${String((err as any)?.message ?? err)}`);
      this.setStatus("DISCONNECTED");
    });
  }

  private startPing() {
    const interval = this.opts.pingIntervalMs;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      // Bybit recommended ping packet every 20s citeturn2view0
      this.sendJson({ op: "ping" });
    }, interval);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    const base = this.opts.reconnectBaseDelayMs;
    const max = this.opts.reconnectMaxDelayMs;

    const exp = Math.min(max, base * Math.pow(2, this.reconnectAttempt));
    const jitter = Math.floor(exp * (0.2 * Math.random())); // up to 20% jitter
    const delay = exp + jitter;

    this.reconnectAttempt += 1;

    this.opts.logger?.info(`[bybit-ws] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(s: BybitConnStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private safeClose() {
    if (!this.ws) return;
    try {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch {
      // ignore
    } finally {
      this.ws = null;
    }
  }

  private clearTimers() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

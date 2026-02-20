import type { SymbolMetrics } from "../domain/contracts.js";
import type { BybitWsClient } from "./bybitWsClient.js";

/**
 * Step 4: subscribe to tickers.{symbol} for all Universe symbols.
 * We keep the latest ticker snapshot/delta per symbol and expose an apply() method
 * that updates the store symbols list at a controlled cadence (1s).
 *
 * Ticker topic and fields documented by Bybit. citeturn1view0
 * Subscribe/ping mechanics documented in WS Connect doc. citeturn2view0
 */

type TickerData = {
  symbol?: string;
  markPrice?: string;
  lastPrice?: string;
  openInterestValue?: string;
  fundingRate?: string;
  nextFundingTime?: string;
};

type TickerMsg = {
  topic?: string;
  type?: "snapshot" | "delta";
  data?: TickerData | TickerData[];
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toNum(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class BybitTickerStream {
  private desiredSymbols: string[] = [];
  private subscribedTopics = new Set<string>();

  private latest = new Map<string, { markPrice?: number; oiValue?: number; fundingRate?: number; nextFundingTimeMs?: number }>();

  constructor(private readonly ws: BybitWsClient, private readonly log: { info: (m: string) => void; warn: (m: string) => void }) {}

  setSymbols(symbols: string[]) {
    // stable ordering
    const unique = Array.from(new Set(symbols)).sort();
    this.desiredSymbols = unique;
    this.reconcileSubscriptions();
  }

  onOpen() {
    // on reconnect, resubscribe everything
    this.subscribedTopics.clear();
    this.reconcileSubscriptions();
  }

  onMessage(msg: any) {
    // command responses or pong, ignore
    const m = msg as TickerMsg;
    if (!m.topic || !m.topic.startsWith("tickers.")) return;

    const payload = Array.isArray(m.data) ? m.data[0] : m.data;
    if (!payload) return;

    const sym = payload.symbol ?? m.topic.split(".")[1];
    if (!sym) return;

    const mark = toNum(payload.markPrice, toNum(payload.lastPrice));
    const oi = toNum(payload.openInterestValue);
    const fr = toNum(payload.fundingRate);
    const nft = toNum(payload.nextFundingTime);

    const prev = this.latest.get(sym) ?? {};
    this.latest.set(sym, {
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : prev.markPrice,
      oiValue: Number.isFinite(oi) && oi >= 0 ? oi : prev.oiValue,
      fundingRate: Number.isFinite(fr) ? fr : prev.fundingRate,
      nextFundingTimeMs: Number.isFinite(nft) && nft > 0 ? nft : prev.nextFundingTimeMs,
    });
  }

  applyToSymbols(symbols: SymbolMetrics[]): SymbolMetrics[] {
    // Update symbols with latest tickers, but do not change candle-based deltas yet (Step 5)
    const now = Date.now();
    return symbols.map((s) => {
      const l = this.latest.get(s.symbol);
      if (!l) return s;
      return {
        ...s,
        markPrice: l.markPrice ?? s.markPrice,
        oiValue: l.oiValue ?? s.oiValue,
        fundingRate: l.fundingRate ?? s.fundingRate,
        fundingTimeMs: now,
        nextFundingTimeMs: l.nextFundingTimeMs ?? s.nextFundingTimeMs,
      };
    });
  }

  private reconcileSubscriptions() {
    // If WS isn't open, sendJson will just no-op, but keep desired list for later.
    const topics = this.desiredSymbols.map((s) => `tickers.${s}`);

    // Subscribe in chunks to keep args reasonable. (Bybit limits args length; we chunk conservatively) citeturn2view0
    const BATCH = 100;
    const needed = topics.filter((t) => !this.subscribedTopics.has(t));
    for (const batch of chunk(needed, BATCH)) {
      if (batch.length === 0) continue;
      const ok = this.ws.sendJson({ op: "subscribe", args: batch });
      if (ok) {
        batch.forEach((t) => this.subscribedTopics.add(t));
      }
    }

    // Unsubscribe topics no longer needed
    const desiredSet = new Set(topics);
    const toRemove = Array.from(this.subscribedTopics).filter((t) => !desiredSet.has(t));
    for (const batch of chunk(toRemove, BATCH)) {
      if (batch.length === 0) continue;
      const ok = this.ws.sendJson({ op: "unsubscribe", args: batch });
      if (ok) {
        batch.forEach((t) => this.subscribedTopics.delete(t));
      }
    }

    this.log.info(`[ticker-stream] desired=${this.desiredSymbols.length} subscribed=${this.subscribedTopics.size}`);
  }
}

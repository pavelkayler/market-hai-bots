import type { Timeframe } from "../domain/contracts.js";
import { bucketStartMs } from "./timeframes.js";

export interface CandlePoint {
  tsMs: number;
  price: number;
  oiValue: number;
}

export interface Candle {
  tf: Timeframe;
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;

  oiOpen: number;
  oiHigh: number;
  oiLow: number;
  oiClose: number;

  lastUpdateMs: number;
}

export interface PrevRefs {
  prevClose?: number;
  prevOiClose?: number;
  prevCandleStartMs?: number;
}

export class CandleEngine {
  private current: Candle | null = null;
  private prev: PrevRefs = {};

  constructor(private tf: Timeframe) {}

  setTimeframe(tf: Timeframe) {
    if (tf === this.tf) return;
    this.tf = tf;
    // Reset because bucket boundaries changed
    this.current = null;
    this.prev = {};
  }

  reset() {
    this.current = null;
    this.prev = {};
  }

  getPrev(): PrevRefs {
    return { ...this.prev };
  }

  /**
   * Pushes a 1s point and updates/rolls candle.
   * Returns whether a candle roll occurred.
   */
  push(p: CandlePoint): { rolled: boolean; current: Candle; prev: PrevRefs } {
    const start = bucketStartMs(p.tsMs, this.tf);

    if (!this.current) {
      this.current = {
        tf: this.tf,
        startMs: start,
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
        oiOpen: p.oiValue,
        oiHigh: p.oiValue,
        oiLow: p.oiValue,
        oiClose: p.oiValue,
        lastUpdateMs: p.tsMs,
      };
      return { rolled: false, current: this.current, prev: this.getPrev() };
    }

    // Roll candle if bucket changed
    if (start !== this.current.startMs) {
      this.prev = {
        prevClose: this.current.close,
        prevOiClose: this.current.oiClose,
        prevCandleStartMs: this.current.startMs,
      };

      this.current = {
        tf: this.tf,
        startMs: start,
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
        oiOpen: p.oiValue,
        oiHigh: p.oiValue,
        oiLow: p.oiValue,
        oiClose: p.oiValue,
        lastUpdateMs: p.tsMs,
      };

      return { rolled: true, current: this.current, prev: this.getPrev() };
    }

    // Update current candle
    this.current.high = Math.max(this.current.high, p.price);
    this.current.low = Math.min(this.current.low, p.price);
    this.current.close = p.price;

    this.current.oiHigh = Math.max(this.current.oiHigh, p.oiValue);
    this.current.oiLow = Math.min(this.current.oiLow, p.oiValue);
    this.current.oiClose = p.oiValue;

    this.current.lastUpdateMs = p.tsMs;

    return { rolled: false, current: this.current, prev: this.getPrev() };
  }
}

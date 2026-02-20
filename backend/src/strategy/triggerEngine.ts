import type { BotConfig, PaperOrder, SymbolMetrics } from "../domain/contracts.js";
import { uid } from "../utils/id.js";
import { dayKeyMsk } from "./dayKey.js";
import { inFundingCooldown } from "./fundingCooldown.js";
import { shouldStayCooldown } from "./postCloseCooldown.js";
import { bucketStartMs } from "../market/timeframes.js";

export interface SymbolStrategyState {
  dayKey: string;
  triggerCountToday: number;
  // prevents multiple trigger increments inside same timeframe candle bucket
  lastTriggerBucketStartMs?: number;
  lastClosedAtMs?: number;
  lastSignalAtMs?: number;
}

export class TriggerEngine {
  private state = new Map<string, SymbolStrategyState>();

  resetSymbols(symbols: string[]) {
    const keep = new Set(symbols);
    for (const k of this.state.keys()) {
      if (!keep.has(k)) this.state.delete(k);
    }
    for (const s of symbols) {
      if (!this.state.has(s)) {
        this.state.set(s, { dayKey: dayKeyMsk(Date.now()), triggerCountToday: 0 });
      } else {
        // keep dayKey; reset count
        const st = this.state.get(s)!;
        st.dayKey = dayKeyMsk(Date.now());
        st.triggerCountToday = 0;
        st.lastTriggerBucketStartMs = undefined;
        st.lastSignalAtMs = undefined;
      st.lastClosedAtMs = undefined;
      st.lastSignalAtMs = undefined;
        st.lastClosedAtMs = undefined;
      st.lastSignalAtMs = undefined;
      }
    }
  }

  getState(symbol: string): SymbolStrategyState {
    const st = this.state.get(symbol);
    if (st) return st;
    const fresh = { dayKey: dayKeyMsk(Date.now()), triggerCountToday: 0 } as SymbolStrategyState;
    this.state.set(symbol, fresh);
    return fresh;
  }

  /**
   * Apply strategy step (per-symbol) and optionally place a paper order.
   * This step is purely deterministic over current SymbolMetrics + configs.
   */
  step(opts: {
    nowMs: number;
    botConfig: BotConfig;
    botRunning: boolean;
    symbol: SymbolMetrics;
    openOrders: PaperOrder[];
  }): void {
    const { nowMs, botConfig, botRunning, symbol, openOrders } = opts;

    // daily reset in MSK
    const dk = dayKeyMsk(nowMs);
    const st = this.getState(symbol.symbol);
    if (st.dayKey !== dk) {
      st.dayKey = dk;
      st.triggerCountToday = 0;
      st.lastTriggerBucketStartMs = undefined;
      st.lastClosedAtMs = undefined;
      st.lastSignalAtMs = undefined;
    }
    // reflect to symbol for UI
    if ((symbol.triggerCountToday ?? 0) > st.triggerCountToday) {
      st.triggerCountToday = symbol.triggerCountToday;
    }
    symbol.triggerCountToday = st.triggerCountToday;
    symbol.lastSignalAtMs = st.lastSignalAtMs ?? null;

    // Funding cooldown overrides most statuses (except active order/position stages)
    const fundingCd = inFundingCooldown(nowMs, symbol.nextFundingTimeMs);
    const activeStage =
      symbol.status === "ORDER_PLACED" ||
      symbol.status === "POSITION_OPEN";

    if (!activeStage) {
      if (fundingCd) {
        symbol.status = "COOLDOWN";
        symbol.reason = "funding cooldown window";
        return;
      } else if (symbol.status === "COOLDOWN") {
        // exit cooldown
        symbol.status = "WAITING_TRIGGER";
        symbol.reason = "waiting trigger";
      }
    }

    // If bot stopped: do not advance strategy (keep display statuses)
    if (!botRunning) {
      if (symbol.status === "AWAITING_CONFIRMATION" || symbol.status === "WAITING_TRIGGER") {
        symbol.reason = "bot stopped";
      }
      return;
    }

// Step 8: after close, enforce 1s cooldown then back to WAITING_TRIGGER
if (symbol.status === "POSITION_CLOSED") {
  if (!st.lastClosedAtMs) st.lastClosedAtMs = nowMs;
  if (shouldStayCooldown(nowMs, st.lastClosedAtMs)) {
    symbol.status = "COOLDOWN";
    symbol.reason = "post-close cooldown (1s)";
    return;
  }
  st.lastClosedAtMs = undefined;
  symbol.status = "WAITING_TRIGGER";
  symbol.reason = "waiting trigger";
  return;
}

if (symbol.status === "COOLDOWN" && symbol.reason?.startsWith("post-close")) {
  // handled above when symbol.status is POSITION_CLOSED; keep as-is
}

    // Only evaluate triggers in these stages
    if (symbol.status !== "WAITING_TRIGGER" && symbol.status !== "AWAITING_CONFIRMATION") return;

    // Need funding filter
    if (Math.abs(symbol.fundingRate) < botConfig.fundingAbsMin) {
      symbol.reason = `waiting funding abs >= ${botConfig.fundingAbsMin}`;
      return;
    }

    // Determine direction by funding sign
    const dir: "LONG" | "SHORT" = symbol.fundingRate >= 0 ? "LONG" : "SHORT";

    // Trigger thresholds by direction:
    // LONG expects positive deltas; SHORT expects negative deltas
    const priceOk =
      dir === "LONG"
        ? symbol.priceDeltaPct >= botConfig.priceDeltaPctThreshold
        : symbol.priceDeltaPct <= -botConfig.priceDeltaPctThreshold;

    const oiOk =
      dir === "LONG"
        ? symbol.oiDeltaPct >= botConfig.oiDeltaPctThreshold
        : symbol.oiDeltaPct <= -botConfig.oiDeltaPctThreshold;

    if (!priceOk || !oiOk) {
      symbol.reason = "waiting trigger (price & OI)";
      return;
    }

    // Gate: only one trigger per timeframe candle bucket
    const bucket = bucketStartMs(nowMs, botConfig.timeframe);
    if (st.lastTriggerBucketStartMs === bucket) {
      symbol.reason = "trigger already counted for this candle";
      return;
    }
    st.lastTriggerBucketStartMs = bucket;

    // Apply counter increment
    st.triggerCountToday += 1;
    st.lastSignalAtMs = nowMs;
    symbol.lastSignalAtMs = nowMs;
    symbol.triggerCountToday = st.triggerCountToday;
    symbol.lastSignalAtMs = st.lastSignalAtMs ?? null;

    // If above max triggers: ignore
    if (st.triggerCountToday > botConfig.maxTriggersPerDay) {
      symbol.status = "WAITING_TRIGGER";
      symbol.reason = `max triggers/day reached (${botConfig.maxTriggersPerDay})`;
      return;
    }

    // Below min => awaiting confirmation
    if (st.triggerCountToday < botConfig.minTriggersPerDay) {
      symbol.status = "AWAITING_CONFIRMATION";
      symbol.reason = `trigger ${st.triggerCountToday}/${botConfig.minTriggersPerDay}: awaiting confirmation`;
      return;
    }

    // In range => place order (paper)
    const side = dir === "LONG" ? "Buy" : "Sell";
    const offset = botConfig.entryOffsetPct / 100;

    const entryPrice =
      dir === "LONG"
        ? symbol.markPrice * (1 - offset)
        : symbol.markPrice * (1 + offset);

    const order: PaperOrder = {
      id: uid("ord_"),
      symbol: symbol.symbol,
      side,
      entryPrice,
      createdAtMs: nowMs,
      status: "OPEN",
    };

    openOrders.push(order);
    symbol.status = "ORDER_PLACED";
    symbol.reason = `order placed (paper) at ${entryPrice.toFixed(4)} after trigger ${st.triggerCountToday}`;
  }
}

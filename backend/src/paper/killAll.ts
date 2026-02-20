import type { PaperOrder, PaperPosition, SymbolMetrics } from "../domain/contracts.js";
import { pnlFromPrices, roiPctFromPnl } from "./paperMath.js";

/**
 * Kill:
 * - cancel all OPEN orders
 * - close all OPEN positions at current markPrice (per symbol) and record
 */
export function killAll(opts: {
  nowMs: number;
  symbols: SymbolMetrics[];
  openOrders: PaperOrder[];
  openPositions: PaperPosition[];
  tradeHistory: PaperPosition[];
}) {
  const { nowMs } = opts;

  // cancel open orders
  for (const o of opts.openOrders) {
    if (o.status === "OPEN") o.status = "CANCELLED";
  }

  const markBySymbol = new Map<string, number>();
  for (const s of opts.symbols) markBySymbol.set(s.symbol, s.markPrice);

  for (const p of opts.openPositions) {
    if (p.status !== "OPEN") continue;
    const mark = markBySymbol.get(p.symbol) ?? p.entryPrice;

    const pnl = pnlFromPrices({ side: p.side, entry: p.entryPrice, exit: mark, qty: p.qty });
    const roi = roiPctFromPnl({ pnlUSDT: pnl, marginUSDT: p.marginUSDT });

    p.status = "CLOSED";
    p.exitPrice = mark;
    p.closedAtMs = nowMs;
    p.pnlUSDT = pnl;
    p.pnlRoiPct = roi;

    if (!p.isRecorded) {
      p.isRecorded = true;
      opts.tradeHistory.push({ ...p });
    }
  }

  // set per-symbol statuses
  for (const s of opts.symbols) {
    s.status = "WAITING_TRIGGER";
    s.reason = "killed";
    s.triggerCountToday = 0;
  }
}

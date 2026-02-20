import type { PaperOrder, PaperPosition, SymbolMetrics, UniversePreset } from "../domain/contracts.js";
import { pnlFromPrices, roiPctFromPnl } from "../paper/paperMath.js";

/**
 * Removes a symbol from active universe (store.symbols).
 * - Cancels OPEN orders for this symbol.
 * - If there is an OPEN position, it is CLOSED immediately at current markPrice and recorded.
 * - Updates current saved universe preset (if currentUniverseName is set) by removing the symbol from its symbols list.
 */
export function removeUniverseSymbol(opts: {
  symbol: string;
  symbols: SymbolMetrics[];
  openOrders: PaperOrder[];
  openPositions: PaperPosition[];
  tradeHistory: PaperPosition[];
  savedUniverses: UniversePreset[];
  currentUniverseName?: string;
}) {
  const { symbol } = opts;

  const sym = opts.symbols.find((s) => s.symbol === symbol);
  const mark = sym?.markPrice ?? 0;

  // cancel open orders
  for (const o of opts.openOrders) {
    if (o.symbol === symbol && o.status === "OPEN") o.status = "CANCELLED";
  }

  // close open positions at current mark (market close)
  for (const p of opts.openPositions) {
    if (p.symbol !== symbol) continue;
    if (p.status !== "OPEN") continue;

    const pnl = pnlFromPrices({ side: p.side, entry: p.entryPrice, exit: mark, qty: p.qty });
    const roi = roiPctFromPnl({ pnlUSDT: pnl, marginUSDT: p.marginUSDT });

    p.status = "CLOSED";
    p.exitPrice = mark;
    p.closedAtMs = Date.now();
    p.pnlUSDT = pnl;
    p.pnlRoiPct = roi;

    if (!p.isRecorded) {
      p.isRecorded = true;
      opts.tradeHistory.push({ ...p });
    }
  }

  // remove from active symbols list
  const idx = opts.symbols.findIndex((s) => s.symbol === symbol);
  if (idx >= 0) opts.symbols.splice(idx, 1);

  // update current saved universe preset (if any)
  if (opts.currentUniverseName) {
    const i = opts.savedUniverses.findIndex((u) => u.name === opts.currentUniverseName);
    if (i >= 0) {
      const u = opts.savedUniverses[i];
      opts.savedUniverses[i] = {
        ...u,
        symbols: u.symbols.filter((s) => s !== symbol),
      };
    }
  }
}

import type { BotConfig, PaperOrder, PaperPosition, SymbolMetrics } from "../domain/contracts.js";
import { uid } from "../utils/id.js";
import { applyFeesToPnl, calcQtyFromMargin, feeUSDT, pnlFromPrices, roiPctFromPnl } from "./paperMath.js";

/**
 * Step 7: paper matching + TP/SL exits.
 * - Fills OPEN orders when markPrice crosses entryPrice (Buy: price<=entry; Sell: price>=entry)
 * - Creates OPEN position
 * - Closes positions on ROI TP/SL (based on margin, as user defined)
 * - After close: symbol status => POSITION_CLOSED, reason, then 1s cooldown handled by strategy (later)
 */

export class PaperMatcher {
  matchOrders(opts: {
    nowMs: number;
    botConfig: BotConfig;
    symbol: SymbolMetrics;
    orders: PaperOrder[];
    positions: PaperPosition[];
  }) {
    const { nowMs, botConfig, symbol, orders, positions } = opts;

    // fill matching orders for this symbol
    for (const o of orders) {
      if (o.status !== "OPEN") continue;
      if (o.symbol !== symbol.symbol) continue;

      const canFill = o.side === "Buy" ? symbol.markPrice <= o.entryPrice : symbol.markPrice >= o.entryPrice;
      if (!canFill) continue;

      o.status = "FILLED";

      const side: PaperPosition["side"] = o.side === "Buy" ? "Long" : "Short";
      const entry = o.entryPrice;

      const qty = calcQtyFromMargin({ marginUSDT: botConfig.marginUSDT, leverage: botConfig.leverage, entryPrice: entry });

      const pos: PaperPosition = {
        entryFeeUSDT: feeUSDT({ role: "TAKER", price: entry, qty }),
        fundingRateAtEntry: symbol.fundingRate,
        fundingAbsAtEntry: Math.abs(symbol.fundingRate),
        nextFundingTimeMsAtEntry: symbol.nextFundingTimeMs,
        id: uid("pos_"),
        symbol: symbol.symbol,
        side,
        entryPrice: entry,
        qty,
        marginUSDT: botConfig.marginUSDT,
        leverage: botConfig.leverage,
        openedAtMs: nowMs,
        status: "OPEN",
      };

      positions.push(pos);

      symbol.status = "POSITION_OPEN";
      symbol.reason = `position open (paper) @ ${entry.toFixed(4)}`;
    }
  }

  exitPositions(opts: {
    nowMs: number;
    botConfig: BotConfig;
    symbol: SymbolMetrics;
    positions: PaperPosition[];
    tradeHistory: PaperPosition[];
  }) {
    const { nowMs, botConfig, symbol, positions, tradeHistory } = opts;

    for (const p of positions) {
      if (p.status !== "OPEN") continue;
      if (p.symbol !== symbol.symbol) continue;

      const pnl = pnlFromPrices({ side: p.side, entry: p.entryPrice, exit: symbol.markPrice, qty: p.qty });
      const roiPct = roiPctFromPnl({ pnlUSDT: pnl, marginUSDT: p.marginUSDT });

      const tp = botConfig.tpRoiPct;
      const sl = -Math.abs(botConfig.slRoiPct);

      const hitTp = roiPct >= tp;
      const hitSl = roiPct <= sl;

      if (!hitTp && !hitSl) {
        // keep live pnl in snapshot
        const exitFeeUSDT = feeUSDT({ role: "MAKER", price: symbol.markPrice, qty: p.qty });
        p.exitFeeUSDT = exitFeeUSDT;
        const pnlAfterFees = applyFeesToPnl({ pnlUSDT: pnl, entryFeeUSDT: p.entryFeeUSDT ?? 0, exitFeeUSDT });
        p.pnlUSDT = pnlAfterFees;
        p.pnlRoiPct = roiPct;
        continue;
      }

      p.status = "CLOSED";

      p.exitPrice = symbol.markPrice;
      p.closedAtMs = nowMs;
      const exitFeeUSDT = feeUSDT({ role: "MAKER", price: symbol.markPrice, qty: p.qty });
      p.exitFeeUSDT = exitFeeUSDT;
      const pnlAfterFees = applyFeesToPnl({ pnlUSDT: pnl, entryFeeUSDT: p.entryFeeUSDT ?? 0, exitFeeUSDT });
      p.pnlUSDT = pnlAfterFees;
      p.pnlRoiPct = roiPct;

      if (!p.isRecorded) {
        p.isRecorded = true;
        tradeHistory.push({ ...p });
      }

      symbol.status = "POSITION_CLOSED";

      symbol.reason = hitTp ? `TP hit (${tp}% ROI)` : `SL hit (${botConfig.slRoiPct}% ROI)`;
    }
  }

  cleanupClosed(opts: { orders: PaperOrder[]; positions: PaperPosition[] }) {
    // Keep in arrays for now (UI shows open only; we keep closed for later history), so no-op.
    // In later steps we can add trade history and cleanup policies.
    void opts;
  }
}

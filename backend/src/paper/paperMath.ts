export function calcQtyFromMargin(opts: { marginUSDT: number; leverage: number; entryPrice: number }): number {
  const { marginUSDT, leverage, entryPrice } = opts;
  if (entryPrice <= 0) return 0;
  // notional = margin * leverage; qty = notional / price
  return (marginUSDT * leverage) / entryPrice;
}

export function pnlFromPrices(opts: { side: "Long" | "Short"; entry: number; exit: number; qty: number }): number {
  const { side, entry, exit, qty } = opts;
  if (qty <= 0) return 0;
  if (side === "Long") return (exit - entry) * qty;
  return (entry - exit) * qty;
}

/**
 * Bybit Perpetual & Futures base fee rates for VIP 0 (no VIP).
 * Source: Bybit Help Center - Trading Fee Structure.
 *
 * Maker: 0.0200%
 * Taker: 0.0550%
 */
export const BYBIT_VIP0_MAKER_FEE_RATE = 0.0002;
export const BYBIT_VIP0_TAKER_FEE_RATE = 0.00055;

export type FeeRole = "MAKER" | "TAKER";

export function feeUSDT(opts: { role: FeeRole; price: number; qty: number }): number {
  const rate = opts.role === "MAKER" ? BYBIT_VIP0_MAKER_FEE_RATE : BYBIT_VIP0_TAKER_FEE_RATE;
  return opts.price * opts.qty * rate;
}

export function applyFeesToPnl(opts: { pnlUSDT: number; entryFeeUSDT: number; exitFeeUSDT: number }): number {
  return opts.pnlUSDT - opts.entryFeeUSDT - opts.exitFeeUSDT;
}

export function roiPctFromPnl(opts: { pnlUSDT: number; marginUSDT: number }): number {
  const { pnlUSDT, marginUSDT } = opts;
  if (marginUSDT <= 0) return 0;
  return (pnlUSDT / marginUSDT) * 100;
}

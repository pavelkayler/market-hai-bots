import type { SymbolMetrics } from "../domain/contracts.js";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];

function round(n: number, d = 4) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

export function makeInitialSymbols(): SymbolMetrics[] {
  const now = Date.now();
  const nextFunding = now + 60 * 60 * 1000; // mock: 1h
  return SYMBOLS.map((s, i) => ({
    symbol: s,
    markPrice: 60000 / (i + 1) + 1000 * (i + 1),
    priceDeltaPct: 0,
    oiValue: 100_000 * (i + 1),
    oiDeltaPct: 0,
    fundingRate: (i % 2 === 0 ? 1 : -1) * 0.01,
    fundingTimeMs: now,
    nextFundingTimeMs: nextFunding,
    status: "WAITING_CANDLE",
    reason: "waiting previous candle",
    triggerCountToday: 0,
  }));
}

export function tickSymbols(prev: SymbolMetrics[]): SymbolMetrics[] {
  const now = Date.now();
  return prev.map((m) => {
    // Random walk
    const priceMove = (Math.random() - 0.5) * 0.2; // %
    const newPrice = m.markPrice * (1 + priceMove / 100);

    const oiMove = (Math.random() - 0.5) * 1.0; // %
    const newOi = m.oiValue * (1 + oiMove / 100);

    const fundingMove = (Math.random() - 0.5) * 0.001;
    const newFunding = round(m.fundingRate + fundingMove, 6);

    // Update status progression mock (only to validate UI wiring)
    let status = m.status;
    let reason = m.reason;

    if (status === "WAITING_CANDLE") {
      status = "WAITING_TRIGGER";
      reason = "waiting trigger";
    } else if (status === "WAITING_TRIGGER" && Math.random() < 0.02) {
      status = "AWAITING_CONFIRMATION";
      reason = "trigger #1 seen, waiting confirmation";
    } else if (status === "AWAITING_CONFIRMATION" && Math.random() < 0.02) {
      status = "ORDER_PLACED";
      reason = "order placed (paper)";
    } else if (status === "ORDER_PLACED" && Math.random() < 0.02) {
      status = "POSITION_OPEN";
      reason = "position open (paper)";
    } else if (status === "POSITION_OPEN" && Math.random() < 0.02) {
      status = "POSITION_CLOSED";
      reason = "position closed (paper)";
    } else if (status === "POSITION_CLOSED") {
      status = "WAITING_TRIGGER";
      reason = "cooldown 1s then waiting trigger";
    }

    return {
      ...m,
      markPrice: round(newPrice, 2),
      priceDeltaPct: round(priceMove, 4),
      oiValue: round(newOi, 2),
      oiDeltaPct: round(oiMove, 4),
      fundingRate: newFunding,
      fundingTimeMs: m.fundingTimeMs,
      nextFundingTimeMs: m.nextFundingTimeMs,
      status,
      reason,
    };
  });
}

import type { PaperOrder, SymbolMetrics } from "../domain/contracts.js";

export function cancelOpenOrders(orders: PaperOrder[], symbols: SymbolMetrics[]) {
  for (const o of orders) {
    if (o.status === "OPEN") o.status = "CANCELLED";
  }
  for (const s of symbols) {
    if (s.status === "ORDER_PLACED") {
      s.status = "WAITING_TRIGGER";
      s.reason = "bot stopped; order cancelled";
    }
  }
}

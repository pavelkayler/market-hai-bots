import type { Store } from "../state/store.js";
import type { BotConfig, SymbolMetrics } from "../domain/contracts.js";
import { SymbolCandleManager } from "../market/symbolCandleManager.js";
import { TriggerEngine } from "../strategy/triggerEngine.js";
import { PaperMatcher } from "../paper/paperMatcher.js";

/**
 * Step 10: deterministic step runner for tests.
 * Mirrors the production loop in index.ts but allows exact control of time and market values.
 */
export function makeSim(opts: { botConfig: BotConfig; symbols: SymbolMetrics[] }) {
  const candleMgr = new SymbolCandleManager(opts.botConfig.timeframe);
  const triggerEngine = new TriggerEngine();
  const paperMatcher = new PaperMatcher();

  candleMgr.resetSymbols(opts.symbols.map((s) => s.symbol));
  triggerEngine.resetSymbols(opts.symbols.map((s) => s.symbol));

  function step(store: Store, nowMs: number) {
    candleMgr.setTimeframe(store.botConfig.timeframe);

    for (const s of store.symbols) {
      const eng = candleMgr.get(s.symbol);
      const oi = Number.isFinite(s.oiValue) ? s.oiValue : 0;
      const out = eng.push({ tsMs: nowMs, price: s.markPrice, oiValue: oi });
      const prevClose = out.prev.prevClose;
      const prevOi = out.prev.prevOiClose;

      if (prevClose === undefined || prevClose <= 0) {
        s.priceDeltaPct = 0;
        s.oiDeltaPct = 0;
        s.status = "WAITING_CANDLE";
        s.reason = "waiting previous candle";
      } else {
        s.priceDeltaPct = ((s.markPrice - prevClose) / prevClose) * 100;
        if (prevOi !== undefined && prevOi > 0) s.oiDeltaPct = ((oi - prevOi) / prevOi) * 100;
        else s.oiDeltaPct = 0;

        if (s.status === "WAITING_CANDLE") {
          s.status = "WAITING_TRIGGER";
          s.reason = "waiting trigger";
        } else if (s.status === "WAITING_TRIGGER") {
          s.reason = "waiting trigger";
        }
      }

      triggerEngine.step({
        nowMs,
        botConfig: store.botConfig,
        botRunning: store.botRunState === "RUNNING",
        symbol: s,
        openOrders: store.openOrders,
      });

      paperMatcher.matchOrders({
        nowMs,
        botConfig: store.botConfig,
        symbol: s,
        orders: store.openOrders,
        positions: store.openPositions,
      });

      paperMatcher.exitPositions({
        nowMs,
        botConfig: store.botConfig,
        symbol: s,
        positions: store.openPositions,
        tradeHistory: store.tradeHistory,
      });
    }
  }

  return { step };
}

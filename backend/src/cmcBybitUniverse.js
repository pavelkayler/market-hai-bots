import { createBybitRest } from "./bybitRest.js";

function normBaseCoin(baseCoin) {
  const s = String(baseCoin || "").trim().toUpperCase();
  return s.replace(/^\d+/, "");
}

export function createCmcBybitUniverse({
  logger = console,
  refreshMs = 6 * 60 * 60 * 1000,
  maxUniverse = 300,
  bybitBaseUrl,
  getBybitFeedSymbols = () => [],
  onUniverseUpdated = () => {},
} = {}) {
  const bybit = createBybitRest({ baseUrl: bybitBaseUrl, logger });
  const state = {
    status: "idle",
    lastRefreshAt: null,
    nextRefreshAt: null,
    error: null,
    warnings: ["CMC_DISABLED_BY_DESIGN"],
    universeUpdatedAt: null,
    cmcEligibleCount: 0,
    bybitLinearCount: 0,
    universeCount: 0,
    universeSymbols: [],
    universeRows: [],
  };
  let timer = null;
  let inflight = null;

  async function refreshOnce() {
    if (inflight) return inflight;
    inflight = (async () => {
      state.status = "loading";
      state.error = null;
      try {
        const instruments = await bybit.getInstrumentsLinearAll();
        const bybitPerps = [];
        for (const it of instruments) {
          const symbol = String(it?.symbol || "").toUpperCase();
          const settle = String(it?.settleCoin || "").toUpperCase();
          const status = String(it?.status || "");
          const contractType = String(it?.contractType || "").toLowerCase();
          if (!symbol || symbol.includes("-")) continue;
          if (settle !== "USDT") continue;
          if (status && status !== "Trading") continue;
          if (contractType && !contractType.includes("perpetual")) continue;
          bybitPerps.push(symbol);
        }

        bybitPerps.sort((a, b) => a.localeCompare(b));
        state.bybitLinearCount = bybitPerps.length;
        const symbols = bybitPerps.slice(0, maxUniverse);
        const bybitFeed = new Set((getBybitFeedSymbols() || []).map((s) => String(s || "").toUpperCase()));
        const rows = symbols.map((tradeSymbol) => ({
          tradeSymbol,
          baseSymbol: normBaseCoin(tradeSymbol.replace(/USDT$/, "")),
          dataSourcesAvailable: { BT: bybitFeed.has(tradeSymbol) },
          preferredDataSourceForAnalytics: "BT",
        }));

        state.universeSymbols = symbols;
        state.universeRows = rows;
        state.universeCount = symbols.length;
        state.status = "ready";
        state.universeUpdatedAt = Date.now();
        state.lastRefreshAt = state.universeUpdatedAt;
        state.nextRefreshAt = state.universeUpdatedAt + refreshMs;
        onUniverseUpdated({ updatedAt: state.universeUpdatedAt, symbols });
      } catch (e) {
        state.status = "error";
        state.error = String(e?.message || e);
        state.lastRefreshAt = Date.now();
        state.nextRefreshAt = Date.now() + refreshMs;
        logger?.warn?.({ err: e }, "universe refresh failed");
      } finally {
        inflight = null;
      }
      return state;
    })();
    return inflight;
  }

  function start() {
    if (timer) return;
    refreshOnce().catch(() => {});
    timer = setInterval(() => { refreshOnce().catch(() => {}); }, refreshMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getStatus() {
    return {
      status: state.status,
      lastRefreshAt: state.lastRefreshAt,
      nextRefreshAt: state.nextRefreshAt,
      error: state.error,
      warnings: state.warnings.slice(),
      universe: { updatedAt: state.universeUpdatedAt, size: state.universeCount },
      cmcEligibleCount: 0,
      bybitLinearCount: state.bybitLinearCount,
    };
  }

  function getUniverse({ limit = 300 } = {}) {
    const n = Math.max(1, Math.min(2000, Number(limit) || 300));
    return { updatedAt: state.universeUpdatedAt, symbols: state.universeSymbols.slice(0, n), rows: state.universeRows.slice(0, n) };
  }

  return { start, stop, refresh: refreshOnce, getStatus, getUniverse };
}

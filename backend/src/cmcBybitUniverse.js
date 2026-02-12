import { createBybitRest } from "./bybitRest.js";

const CMC_BASE = "https://pro-api.coinmarketcap.com";

function normBaseCoin(baseCoin) {
  const s = String(baseCoin || "").trim().toUpperCase();
  return s.replace(/^\d+/, "");
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    const data = JSON.parse(text);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCmcListings({ apiKey, minMarketCapUsd, limit = 5000 }) {
  const url = new URL(`${CMC_BASE}/v1/cryptocurrency/listings/latest`);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("convert", "USD");
  const j = await fetchJsonWithTimeout(url.toString(), { headers: { "X-CMC_PRO_API_KEY": apiKey }, timeoutMs: 20000 });

  const out = new Set();
  const rows = Array.isArray(j?.data) ? j.data : [];
  for (const r of rows) {
    const symbol = String(r?.symbol || "").trim().toUpperCase();
    const mc = Number(r?.quote?.USD?.market_cap);
    if (!symbol || !Number.isFinite(mc) || mc < minMarketCapUsd) continue;
    out.add(`${symbol}USDT`);
  }
  return out;
}

export function createCmcBybitUniverse({
  logger = console,
  minMarketCapUsd = 10_000_000,
  refreshMs = 6 * 60 * 60 * 1000,
  maxUniverse = 300,
  bybitBaseUrl,
  getBybitFeedSymbols = () => [],
  getBinanceFeedSymbols = () => [],
  onUniverseUpdated = () => {},
} = {}) {
  const bybit = createBybitRest({ baseUrl: bybitBaseUrl, logger });

  const state = {
    status: "idle",
    lastRefreshAt: null,
    nextRefreshAt: null,
    error: null,
    warnings: [],
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
      state.warnings = [];

      const apiKey = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";
      if (!apiKey) {
        state.status = "ready";
        state.warnings = ["CMC_DISABLED"];
        state.lastRefreshAt = Date.now();
        state.nextRefreshAt = Date.now() + refreshMs;
        state.universeUpdatedAt = state.lastRefreshAt;
        state.universeSymbols = [];
        state.universeRows = [];
        state.universeCount = 0;
        onUniverseUpdated({ updatedAt: state.universeUpdatedAt, symbols: [] });
        inflight = null;
        return state;
      }

      try {
        const cmcCandidates = await fetchCmcListings({ apiKey, minMarketCapUsd });
        state.cmcEligibleCount = cmcCandidates.size;

        const instruments = await bybit.getInstrumentsLinearAll();
        const bybitPerps = new Set();
        for (const it of instruments) {
          const symbol = String(it?.symbol || "").toUpperCase();
          const quote = String(it?.quoteCoin || "").toUpperCase();
          const status = String(it?.status || "");
          const contractType = String(it?.contractType || "").toLowerCase();
          if (!symbol || symbol.includes("-")) continue;
          if (quote !== "USDT") continue;
          if (status && status !== "Trading") continue;
          if (contractType && !contractType.includes("perpetual")) continue;
          bybitPerps.add(symbol);
        }

        state.bybitLinearCount = bybitPerps.size;

        const raw = [];
        for (const candidate of cmcCandidates) {
          if (!bybitPerps.has(candidate)) continue;
          raw.push(candidate);
        }

        const symbols = raw.slice(0, maxUniverse);
        const bybitFeed = new Set((getBybitFeedSymbols() || []).map((s) => String(s || "").toUpperCase()));
        const binanceFeed = new Set((getBinanceFeedSymbols() || []).map((s) => String(s || "").toUpperCase()));
        const rows = symbols.map((tradeSymbol) => ({
          tradeSymbol,
          baseSymbol: normBaseCoin(tradeSymbol.replace(/USDT$/, "")),
          dataSourcesAvailable: {
            BT: bybitFeed.has(tradeSymbol),
            BNB: binanceFeed.has(tradeSymbol),
          },
          preferredDataSourceForAnalytics: "BNB",
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
    timer = setInterval(() => {
      refreshOnce().catch(() => {});
    }, refreshMs);
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
      cmcEligibleCount: state.cmcEligibleCount,
      bybitLinearCount: state.bybitLinearCount,
    };
  }

  function getUniverse({ limit = 300 } = {}) {
    const n = Math.max(1, Math.min(2000, Number(limit) || 300));
    return {
      updatedAt: state.universeUpdatedAt,
      symbols: state.universeSymbols.slice(0, n),
      rows: state.universeRows.slice(0, n),
    };
  }

  return { start, stop, refresh: refreshOnce, getStatus, getUniverse };
}

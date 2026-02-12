// backend/src/cmcBybitUniverse.js
// Build a tradable universe: Bybit USDT linear perps whose underlying market cap > $10M (CoinMarketCap).
// Requires env: CMC_API_KEY (preferred) or COINMARKETCAP_API_KEY.

import { createBybitRest } from "./bybitRest.js";

const CMC_BASE = "https://pro-api.coinmarketcap.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normBaseCoin(baseCoin) {
  // Bybit sometimes uses scaled tokens like 1000PEPE.
  const s = String(baseCoin || "").trim().toUpperCase();
  return s.replace(/^\d+/, "");
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { _raw: text };
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.payload = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCmcListings({ apiKey, minMarketCapUsd, limit = 5000 }) {
  // Returns a Map(symbol->rank) of coins with market cap >= minMarketCapUsd
  const url = new URL(`${CMC_BASE}/v1/cryptocurrency/listings/latest`);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("convert", "USD");

  const j = await fetchJsonWithTimeout(url.toString(), {
    headers: { "X-CMC_PRO_API_KEY": apiKey },
    timeoutMs: 20000,
  });

  const m = new Map();
  const rows = Array.isArray(j?.data) ? j.data : [];
  for (const r of rows) {
    const sym = String(r?.symbol || "").trim().toUpperCase();
    const rank = Number(r?.cmc_rank);
    const mc = Number(r?.quote?.USD?.market_cap);
    if (!sym || !Number.isFinite(mc) || mc < minMarketCapUsd) continue;
    m.set(sym, Number.isFinite(rank) ? rank : 999999);
  }
  return m;
}

export function createCmcBybitUniverse({
  logger = console,
  minMarketCapUsd = 10_000_000,
  refreshMs = 6 * 60 * 60 * 1000,
  maxUniverse = 300,
  bybitBaseUrl,
} = {}) {
  const bybit = createBybitRest({ baseUrl: bybitBaseUrl, logger });

  const state = {
    status: "idle", // idle|loading|ready|error
    lastRefreshAt: null,
    nextRefreshAt: null,
    error: null,

    cmcMinMarketCapUsd: minMarketCapUsd,
    cmcEligibleCount: 0,

    bybitLinearCount: 0,
    universeCount: 0,

    universeSymbols: [], // Bybit symbols (e.g., BTCUSDT)
  };

  let timer = null;
  let inflight = null;

  async function refreshOnce() {
    if (inflight) return inflight;
    inflight = (async () => {
      state.status = "loading";
      state.error = null;

      const apiKey = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";
      if (!apiKey) {
        state.status = "error";
        state.error = "CMC_API_KEY is missing";
        state.lastRefreshAt = Date.now();
        state.nextRefreshAt = Date.now() + refreshMs;
        state.universeSymbols = [];
        state.universeCount = 0;
        return state;
      }

      try {
        // 1) CoinMarketCap: eligible base symbols
        const cmcRank = await fetchCmcListings({ apiKey, minMarketCapUsd });
        state.cmcEligibleCount = cmcRank.size;

        // 2) Bybit: list linear instruments
        const instruments = await bybit.getInstrumentsLinearAll();
        state.bybitLinearCount = instruments.length;

        const candidates = [];
        for (const it of instruments) {
          const symbol = String(it?.symbol || "").toUpperCase();
          const status = String(it?.status || "");
          const quote = String(it?.quoteCoin || "").toUpperCase();

          // We trade USDT-margined perpetuals only.
          // Bybit's "linear" category includes delivery futures like DOGEUSDT-13FEB26.
          // Filter them out by contractType (preferred) and a symbol guard.
          const contractType = String(it?.contractType || "").toLowerCase();
          if (contractType && !contractType.includes("perpetual")) continue;
          if (symbol.includes("-")) continue;

          if (!symbol || quote !== "USDT") continue;
          if (status && status !== "Trading") continue;

          const base = normBaseCoin(it?.baseCoin);
          const rank = cmcRank.get(base);
          if (!rank) continue;

          candidates.push({ symbol, rank });
        }

        candidates.sort((a, b) => a.rank - b.rank);
        const universe = candidates.slice(0, maxUniverse).map((x) => x.symbol);

        state.universeSymbols = universe;
        state.universeCount = universe.length;
        state.status = "ready";
        state.lastRefreshAt = Date.now();
        state.nextRefreshAt = Date.now() + refreshMs;
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
    // First refresh quickly, then interval.
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
    return { ...state, universeSymbols: undefined };
  }

  function getUniverse({ limit = 200 } = {}) {
    const n = Math.min(2000, Math.max(1, Number(limit) || 200));
    return state.universeSymbols.slice(0, n);
  }

  // manual trigger used by UI/ops
  async function refresh() {
    return refreshOnce();
  }

  return { start, stop, refresh, getStatus, getUniverse };
}

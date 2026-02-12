// backend/src/bybitKlinesCache.js
// Simple rate-limited cache for Bybit REST klines.

import { createBybitRest } from "./bybitRest.js";

function keyOf(symbol, interval) {
  return `${String(symbol).toUpperCase()}|${String(interval)}`;
}

function now() {
  return Date.now();
}

export function createBybitKlinesCache({
  logger = console,
  bybitBaseUrl,
  // Minimum time between refreshes per interval (ms)
  minRefreshMsByInterval = {
    "5": 12_000,
    "15": 20_000,
    "60": 60_000,
  },
  maxConcurrent = 4,
} = {}) {
  const bybit = createBybitRest({ baseUrl: bybitBaseUrl, logger });

  const entries = new Map();
  const queue = [];
  let inflight = 0;

  function schedule(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (inflight < maxConcurrent && queue.length) {
      const it = queue.shift();
      inflight++;
      Promise.resolve()
        .then(it.task)
        .then((v) => it.resolve(v))
        .catch((e) => it.reject(e))
        .finally(() => {
          inflight--;
          pump();
        });
    }
  }

  async function getCandles({ symbol, interval, limit = 220, force = false }) {
    const sym = String(symbol || "").toUpperCase();
    const intv = String(interval);
    const k = keyOf(sym, intv);

    if (!sym) return [];

    let e = entries.get(k);
    if (!e) {
      e = {
        candles: [],
        lastFetchedAt: 0,
        lastCandleT: 0,
        error: null,
        inflight: null,
      };
      entries.set(k, e);
    }

    const minMs = Number(minRefreshMsByInterval[intv] ?? 20_000);
    const age = now() - e.lastFetchedAt;

    if (!force && e.candles.length && age < minMs) {
      return e.candles;
    }

    if (e.inflight) return e.inflight;

    e.inflight = schedule(async () => {
      try {
        const candles = await bybit.getKlines({ symbol: sym, interval: intv, limit });
        e.candles = candles;
        e.lastFetchedAt = now();
        e.lastCandleT = candles.length ? candles[candles.length - 1].t : 0;
        e.error = null;
        return candles;
      } catch (err) {
        e.lastFetchedAt = now();
        e.error = String(err?.message || err);
        logger?.warn?.({ err }, "klines fetch failed");
        return e.candles;
      } finally {
        e.inflight = null;
      }
    });

    return e.inflight;
  }

  function getEntryStatus({ symbol, interval }) {
    const k = keyOf(String(symbol).toUpperCase(), String(interval));
    const e = entries.get(k);
    if (!e) return null;
    return {
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      lastFetchedAt: e.lastFetchedAt,
      lastCandleT: e.lastCandleT,
      size: e.candles.length,
      error: e.error,
    };
  }

  function getStatus() {
    return {
      inflight,
      queued: queue.length,
      entries: entries.size,
    };
  }

  return { getCandles, getEntryStatus, getStatus };
}

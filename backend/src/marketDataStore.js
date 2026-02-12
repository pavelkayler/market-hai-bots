// backend/src/marketDataStore.js

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSource(source) {
  const src = String(source || "").trim().toUpperCase();
  if (src === "BT" || src === "BYBIT") return "BT";
  if (src === "BNB" || src === "BINANCE") return "BNB";
  return null;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function createMarketDataStore() {
  const tickers = new Map(); // key: `${source}:${symbol}` -> ticker

  function keyOf(source, symbol) {
    return `${source}:${symbol}`;
  }

  function upsertTicker(input) {
    const symbol = normalizeSymbol(input?.symbol);
    const source = normalizeSource(input?.source || input?.src);
    if (!symbol || !source) return null;

    const bid = numOrNull(input?.bid);
    const ask = numOrNull(input?.ask);
    const last = numOrNull(input?.last);
    const mark = source === "BT" ? numOrNull(input?.mark) : null;

    const mid = bid !== null && ask !== null ? (bid + ask) / 2 : last;
    const tsRaw = Number(input?.ts ?? input?.receivedAt ?? Date.now());
    const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now();

    const ticker = { symbol, source, ts, bid, ask, mid, last, mark };
    tickers.set(keyOf(source, symbol), ticker);
    return ticker;
  }

  function getTicker(symbol, source) {
    const sym = normalizeSymbol(symbol);
    const src = normalizeSource(source);
    if (!sym || !src) return null;
    return tickers.get(keyOf(src, sym)) || null;
  }

  function getTickersArray() {
    return [...tickers.values()];
  }

  function getTickersBySource(source) {
    const src = normalizeSource(source);
    if (!src) return {};
    const out = {};
    for (const t of tickers.values()) {
      if (t.source === src) out[t.symbol] = t;
    }
    return out;
  }

  return { upsertTicker, getTicker, getTickersArray, getTickersBySource };
}

export function toLegacySource(source) {
  const src = normalizeSource(source);
  if (src === "BNB") return "binance";
  return "bybit";
}

export function toTickerSourceCode(source) {
  return normalizeSource(source);
}

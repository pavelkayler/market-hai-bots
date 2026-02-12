// backend/src/bybitRest.js
// Lightweight Bybit V5 REST client (public endpoints only)

const DEFAULT_BASE = "https://api.bybit.com";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 10000 } = {}) {
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

export function createBybitRest({ baseUrl = DEFAULT_BASE, logger = console } = {}) {
  async function getInstrumentsLinearAll() {
    // Bybit returns paginated list via cursor
    const out = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const url = new URL(`${baseUrl}/v5/market/instruments-info`);
      url.searchParams.set("category", "linear");
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);

      const j = await fetchJsonWithTimeout(url.toString(), { timeoutMs: 15000 });
      if (j?.retCode !== 0) {
        const err = new Error(`Bybit retCode ${j?.retCode}`);
        err.payload = j;
        throw err;
      }

      const list = j?.result?.list || [];
      out.push(...list);
      cursor = j?.result?.nextPageCursor || "";
      if (!cursor) break;

      // small polite delay
      await sleep(120);
    }
    return out;
  }

  async function getKlines({ symbol, interval, limit = 200 }) {
    const url = new URL(`${baseUrl}/v5/market/kline`);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", String(interval));
    url.searchParams.set("limit", String(limit));

    const j = await fetchJsonWithTimeout(url.toString(), { timeoutMs: 15000 });
    if (j?.retCode !== 0) {
      const err = new Error(`Bybit retCode ${j?.retCode}`);
      err.payload = j;
      throw err;
    }

    // result.list is array of arrays: [ startTime, open, high, low, close, volume, turnover ]
    const rows = j?.result?.list || [];
    const candles = rows
      .map((r) => ({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.o) && Number.isFinite(x.h) && Number.isFinite(x.l) && Number.isFinite(x.c))
      .sort((a, b) => a.t - b.t);

    return candles;
  }



  async function getOpenInterest({ symbol, interval = "15", limit = 50 } = {}) {
    const url = new URL(`${baseUrl}/v5/market/open-interest`);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("intervalTime", String(interval));
    url.searchParams.set("limit", String(limit));

    const j = await fetchJsonWithTimeout(url.toString(), { timeoutMs: 15000 });
    if (j?.retCode !== 0) {
      const err = new Error(`Bybit retCode ${j?.retCode}`);
      err.payload = j;
      throw err;
    }

    const rows = j?.result?.list || [];
    return rows
      .map((r) => ({ t: Number(r.timestamp), oi: Number(r.openInterest) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.oi))
      .sort((a, b) => a.t - b.t);
  }

  async function getFundingHistory({ symbol, limit = 50 } = {}) {
    const url = new URL(`${baseUrl}/v5/market/funding/history`);
    url.searchParams.set("category", "linear");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("limit", String(limit));

    const j = await fetchJsonWithTimeout(url.toString(), { timeoutMs: 15000 });
    if (j?.retCode !== 0) {
      const err = new Error(`Bybit retCode ${j?.retCode}`);
      err.payload = j;
      throw err;
    }

    const rows = j?.result?.list || [];
    return rows
      .map((r) => ({ t: Number(r.fundingRateTimestamp), rate: Number(r.fundingRate) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.rate))
      .sort((a, b) => a.t - b.t);
  }
  return {
    getInstrumentsLinearAll,
    getKlines,
    getOpenInterest,
    getFundingHistory,
    _fetchJsonWithTimeout: fetchJsonWithTimeout,
  };
}

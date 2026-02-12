// backend/src/bybitPrivateRest.js
import crypto from "crypto";

const DEFAULT_BASE = "https://api.bybit.com";
const DEFAULT_RECV_WINDOW = 5000;

function hmacSHA256(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function fetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
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
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

export function createBybitPrivateRest({
  apiKey,
  apiSecret,
  baseUrl = DEFAULT_BASE,
  recvWindow = DEFAULT_RECV_WINDOW,
} = {}) {
  if (!apiKey || !apiSecret) {
    return {
      enabled: false,
      getStatus: () => ({ enabled: false, baseUrl, recvWindow, reason: "missing_keys" }),
    };
  }

  function signRequest({ ts, method, queryString, bodyString }) {
    const preSign = `${ts}${apiKey}${recvWindow}${method === "GET" ? queryString : bodyString}`;
    return hmacSHA256(apiSecret, preSign);
  }

  async function request(method, path, { query = null, body = null, timeoutMs = 15000 } = {}) {
    const ts = String(Date.now());
    const url = new URL(`${baseUrl}${path}`);

    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const queryString = url.searchParams.toString();
    const bodyString = body ? JSON.stringify(body) : "";
    const sign = signRequest({ ts, method, queryString, bodyString });

    const headers = {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-SIGN-TYPE": "2",
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": String(recvWindow),
    };

    const res = await fetchJson(url.toString(), {
      method,
      headers,
      body: method === "GET" ? null : bodyString,
      timeoutMs,
    });

    if (res?.retCode !== 0) {
      const err = new Error(`Bybit retCode=${res?.retCode} retMsg=${res?.retMsg || "unknown"} path=${path}`);
      err.payload = { path, method, query, body, response: res };
      throw err;
    }

    return res;
  }

  const api = {
    enabled: true,
    getStatus: () => ({ enabled: true, baseUrl, recvWindow }),
    request,
    placeOrder: (body) => request("POST", "/v5/order/create", { body }),
    cancelAll: (body) => request("POST", "/v5/order/cancel-all", { body }),
    getOrdersRealtime: (query) => request("GET", "/v5/order/realtime", { query }),
    getPositions: (query) => request("GET", "/v5/position/list", { query }),
    setTradingStop: (body) => request("POST", "/v5/position/trading-stop", { body }),
    getClosedPnl: (query) => request("GET", "/v5/position/closed-pnl", { query }),
    setLeverage: (body) => request("POST", "/v5/position/set-leverage", { body }),
    getInstrumentsInfo: (query) => request("GET", "/v5/market/instruments-info", { query }),
  };

  return api;
}

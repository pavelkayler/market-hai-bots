// backend/src/binanceSpotWs.js
// Binance Spot public WS (bookTicker) with dynamic subscribe/unsubscribe.
// Normalized output: {src,symbol,receivedAt,bid,ask,last}

import WebSocket from "ws";

const DEFAULT_URL = "wss://stream.binance.com:9443/ws";

export function createBinanceSpotWs({
  url = DEFAULT_URL,
  symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  logger = console,
  onStatus = () => {},
  onTicker = () => {},
} = {}) {
  let ws = null;
  let status = "disconnected"; // disconnected | connecting | connected
  let desiredSymbols = uniqSymbols(symbols);
  let subscribed = new Set();

  const normalizedState = new Map(); // symbol -> ticker

  let reconnectTimer = null;
  let pingTimer = null;
  let backoffMs = 1000;
  let reqId = 1;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus({ status, url, desiredSymbols });
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function safeSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function scheduleReconnect() {
    clearTimers();
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, 15000);
      connect();
    }, backoffMs);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearTimers();
    setStatus("connecting");

    ws = new WebSocket(url);

    ws.on("open", () => {
      backoffMs = 1000;
      subscribed = new Set();
      setStatus("connected");

      // subscribe current desired
      subscribeSymbols(desiredSymbols);

      // keepalive: send WS ping frames (30s)
      pingTimer = setInterval(() => {
        try {
          ws?.ping?.();
        } catch {
          // ignore
        }
      }, 30000);
    });

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return;
      }

      // subscription ACK: {result:null,id:...}
      if (Object.prototype.hasOwnProperty.call(msg, "result") && Object.prototype.hasOwnProperty.call(msg, "id")) {
        return;
      }

      // bookTicker event
      const symbol = typeof msg?.s === "string" ? msg.s.toUpperCase() : null;
      if (!symbol) return;

      const bid = num(msg?.b);
      const ask = num(msg?.a);
      const last = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : (Number.isFinite(bid) ? bid : (Number.isFinite(ask) ? ask : null));

      const normalized = {
        src: "binance",
        symbol,
        receivedAt: Date.now(),
        bid,
        ask,
        last,
      };

      normalizedState.set(symbol, normalized);
      onTicker(normalized);
    });

    ws.on("close", () => {
      setStatus("disconnected");
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      logger?.warn?.("[binance ws] error:", err?.message || err);
      // close will trigger reconnect
    });
  }

  function streamFor(sym) {
    return `${String(sym).trim().toLowerCase()}@bookTicker`;
  }

  function subscribeSymbols(syms) {
    const params = syms.map(streamFor).filter(Boolean);
    const newOnes = params.filter((p) => !subscribed.has(p));
    if (!newOnes.length) return;

    safeSend({ method: "SUBSCRIBE", params: newOnes, id: reqId++ });
    newOnes.forEach((p) => subscribed.add(p));
  }

  function unsubscribeSymbols(syms) {
    const params = syms.map(streamFor).filter(Boolean);
    const oldOnes = params.filter((p) => subscribed.has(p));
    if (!oldOnes.length) return;

    safeSend({ method: "UNSUBSCRIBE", params: oldOnes, id: reqId++ });
    oldOnes.forEach((p) => subscribed.delete(p));
  }

  function setSymbols(nextSymbols) {
    const next = uniqSymbols(nextSymbols);
    const prev = desiredSymbols;
    desiredSymbols = next;

    const toUnsub = prev.filter((s) => !next.includes(s));
    const toSub = next.filter((s) => !prev.includes(s));

    if (ws && ws.readyState === WebSocket.OPEN) {
      unsubscribeSymbols(toUnsub);
      subscribeSymbols(toSub);
    } else {
      connect();
    }

    onStatus({ status, url, desiredSymbols });
  }

  function getStatus() {
    return { status, url, desiredSymbols };
  }

  function getSymbols() {
    return [...desiredSymbols];
  }

  function getTickers() {
    const out = {};
    for (const [sym, t] of normalizedState.entries()) out[sym] = t;
    return out;
  }

  function close() {
    clearTimers();
    try {
      ws?.close?.();
    } catch {}
    ws = null;
    setStatus("disconnected");
  }

  // start immediately
  connect();

  return {
    connect,
    close,
    setSymbols,
    getStatus,
    getSymbols,
    getTickers,
  };
}

function uniqSymbols(input) {
  const arr = Array.isArray(input) ? input : [];
  const cleaned = arr
    .map((s) => (typeof s === "string" ? s.trim().toUpperCase() : ""))
    .filter(Boolean)
    .map((s) => s.replace("/", "").replace("-", ""));
  return [...new Set(cleaned)];
}

function num(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// backend/src/bybitPublicWs.js
import WebSocket from "ws";

const DEFAULT_URL = "wss://stream.bybit.com/v5/public/linear";

function uniqSymbols(arr) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(arr) ? arr : []) {
    const sym = String(s || "").trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeTicker(raw, { symbol, receivedAt, bybitTs } = {}) {
  const lastPrice = num(raw.lastPrice ?? raw.last_price);
  const bid1Price = num(raw.bid1Price ?? raw.bid1_price);
  const ask1Price = num(raw.ask1Price ?? raw.ask1_price);
  const markPrice = num(raw.markPrice ?? raw.mark_price);
  const indexPrice = num(raw.indexPrice ?? raw.index_price);
  const fundingRate = num(raw.fundingRate ?? raw.funding_rate);
  const openInterest = num(raw.openInterest ?? raw.open_interest);

  const mid = bid1Price !== null && ask1Price !== null ? (bid1Price + ask1Price) / 2 : lastPrice;

  return {
    src: "bybit",
    symbol,
    receivedAt,
    bybitTs: typeof bybitTs === "number" ? bybitTs : null,
    last: lastPrice,
    bid: bid1Price,
    ask: ask1Price,
    mid,
    mark: markPrice,
    index: indexPrice,
    funding: fundingRate,
    oi: openInterest,
  };
}

// Bybit V5 public topics used:
// - tickers.{symbol}
// - allLiquidation.{symbol}
// - publicTrade.{symbol}
export function createBybitPublicWs({
  url = DEFAULT_URL,
  symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  logger = console,
  onStatus = () => {},
  onTicker = () => {},
  enableLiquidations = false,
  onLiquidation = () => {},
  enableTrades = false,
  onTrade = () => {},
} = {}) {
  let ws = null;

  let status = "disconnected";
  let desiredSymbols = uniqSymbols(symbols);
  let subscribedTopics = new Set();

  const rawTickerState = new Map();
  const normalizedState = new Map();

  let reconnectTimer = null;
  let pingTimer = null;
  let backoffMs = 1000;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus({ status, url, desiredSymbols });
  }

  function safeSend(obj) {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function topicFor(sym, kind) {
    if (kind === "ticker") return `tickers.${sym}`;
    if (kind === "liq") return `allLiquidation.${sym}`;
    if (kind === "trade") return `publicTrade.${sym}`;
    return null;
  }

  function desiredTopicsForSymbols(syms) {
    const topics = [];
    for (const sym of syms) {
      topics.push(topicFor(sym, "ticker"));
      if (enableLiquidations) topics.push(topicFor(sym, "liq"));
      if (enableTrades) topics.push(topicFor(sym, "trade"));
    }
    return topics.filter(Boolean);
  }

  function subscribeTopics(topics) {
    const toSub = topics.filter((t) => t && !subscribedTopics.has(t));
    if (!toSub.length) return;
    safeSend({ op: "subscribe", args: toSub });
    for (const t of toSub) subscribedTopics.add(t);
  }

  function unsubscribeTopics(topics) {
    const toUn = topics.filter((t) => t && subscribedTopics.has(t));
    if (!toUn.length) return;
    safeSend({ op: "unsubscribe", args: toUn });
    for (const t of toUn) subscribedTopics.delete(t);
  }

  function resubscribe() {
    subscribeTopics(desiredTopicsForSymbols(desiredSymbols));
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    clearTimers();
    setStatus("connecting");

    ws = new WebSocket(url);

    ws.on("open", () => {
      backoffMs = 1000;
      subscribedTopics = new Set();
      setStatus("connected");

      resubscribe();

      pingTimer = setInterval(() => {
        safeSend({ op: "ping" });
      }, 20000);
    });

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return;
      }

      if (msg?.op === "pong") return;

      const topic = msg?.topic;
      if (typeof topic !== "string") return;

      if (topic.startsWith("tickers.")) {
        const symbol = topic.slice("tickers.".length);
        const type = msg.type;
        const data = msg.data;
        if (!symbol || !data) return;

        const prev = rawTickerState.get(symbol) || {};
        const merged = type === "snapshot" ? { ...data } : { ...prev, ...data };
        rawTickerState.set(symbol, merged);

        const normalized = normalizeTicker(merged, {
          symbol,
          receivedAt: Date.now(),
          bybitTs: typeof msg.ts === "number" ? msg.ts : null,
        });

        normalizedState.set(symbol, normalized);
        onTicker(normalized);
        return;
      }

      if (topic.startsWith("allLiquidation.")) {
        if (!enableLiquidations) return;
        const symbol = topic.slice("allLiquidation.".length);
        const data = msg.data;
        if (!symbol || !data) return;

        const arr = Array.isArray(data) ? data : [data];
        for (const ev of arr) {
          const side = String(ev.side || "").toUpperCase();
          const price = num(ev.price);
          const size = num(ev.size);
          const ts = Number(ev.timestamp || ev.time || msg.ts || Date.now());
          onLiquidation({
            src: "bybit",
            symbol,
            side,
            price,
            size,
            ts: Number.isFinite(ts) ? ts : Date.now(),
          });
        }
        return;
      }

      if (topic.startsWith("publicTrade.")) {
        if (!enableTrades) return;
        const symbol = topic.slice("publicTrade.".length);
        const data = msg.data;
        if (!symbol || !data) return;

        const arr = Array.isArray(data) ? data : [data];
        for (const ev of arr) {
          onTrade({
            src: "bybit",
            symbol,
            side: String(ev.side || "").toUpperCase(),
            price: num(ev.price),
            size: num(ev.size),
            ts: Number(ev.time || ev.timestamp || msg.ts || Date.now()),
          });
        }
      }
    });

    ws.on("close", () => {
      setStatus("disconnected");
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      logger?.warn?.("[bybit ws] error:", err?.message || err);
    });
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

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function setSymbols(nextSymbols) {
    const next = uniqSymbols(nextSymbols);
    const prev = desiredSymbols;
    desiredSymbols = next;

    if (ws && ws.readyState === WebSocket.OPEN) {
      const prevSet = new Set(prev);
      const nextSet = new Set(next);

      const toUn = [];
      for (const sym of prevSet) {
        if (!nextSet.has(sym)) {
          toUn.push(topicFor(sym, "ticker"));
          toUn.push(topicFor(sym, "liq"));
          toUn.push(topicFor(sym, "trade"));
        }
      }
      unsubscribeTopics(toUn);
      resubscribe();
    }

    onStatus({ status, url, desiredSymbols });
  }

  function getStatus() {
    return {
      status,
      url,
      desiredSymbols,
      subscribedTopics: Array.from(subscribedTopics),
    };
  }

  function getSymbols() {
    return [...desiredSymbols];
  }

  function getTickers() {
    const out = {};
    for (const [sym, t] of normalizedState.entries()) out[sym] = t;
    return out;
  }

  connect();

  return {
    setSymbols,
    getStatus,
    getSymbols,
    getTickers,
  };
}

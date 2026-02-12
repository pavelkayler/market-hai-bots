// backend/src/server.js
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import WebSocket from "ws";

import { createBybitPublicWs } from "./bybitPublicWs.js";
import { createBinanceSpotWs } from "./binanceSpotWs.js";
import { createMicroBarAggregator } from "./microBars.js";
import { createLeadLag } from "./leadLag.js";
import { createPaperTest } from "./paperTest.js";
import { createCmcBybitUniverse } from "./cmcBybitUniverse.js";
import { createBybitKlinesCache } from "./bybitKlinesCache.js";
import { createPullbackTest } from "./pullbackTest.js";
import { createRangeMetricsTest } from "./rangeMetricsTest.js";
import { createBybitPrivateRest } from "./bybitPrivateRest.js";
import { createBybitInstrumentsCache } from "./bybitInstrumentsCache.js";
import { createBybitTradeExecutor } from "./bybitTradeExecutor.js";
import { createBybitRest } from "./bybitRest.js";
import { createMarketDataStore, toLegacySource, toTickerSourceCode } from "./marketDataStore.js";

dotenv.config();

const app = Fastify({ logger: true });
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const WS_OPEN = WebSocket.OPEN;

await app.register(cors, { origin: ["http://localhost:5173", "http://127.0.0.1:5173"] });
await app.register(websocket);

const clients = new Set();
function safeSend(ws, obj) {
  if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws && ws.readyState === WS_OPEN) ws.send(msg);
  }
}

function normalizeSymbols(symbols) {
  if (!Array.isArray(symbols)) return [];
  const uniq = new Set();
  for (const sym of symbols) {
    if (typeof sym !== "string") continue;
    const normalized = sym.trim().toUpperCase().replace(/[\/-]/g, "");
    if (!normalized) continue;
    uniq.add(normalized);
    if (uniq.size >= 10) break;
  }
  return [...uniq];
}

function tradeStatus(tradeExecutor) {
  const baseUrl = process.env.BYBIT_TRADE_BASE_URL || "https://api-demo.bybit.com";
  const recvWindow = Number(process.env.BYBIT_RECV_WINDOW || 5000);
  return {
    enabled: Boolean(tradeExecutor?.enabled?.()),
    demo: /api-demo\.bybit\.com/i.test(baseUrl),
    baseUrl,
    recvWindow,
  };
}

function tradeWarnings(tradeExecutor) {
  const warnings = [];
  const ts = tradeStatus(tradeExecutor);
  if (!ts.enabled) warnings.push({ code: "TRADE_DISABLED", severity: "error", message: "Missing BYBIT_API_KEY/BYBIT_API_SECRET" });
  if (ts.enabled && !ts.demo) warnings.push({ code: "TRADE_BASE_URL", severity: "warn", message: "BYBIT_TRADE_BASE_URL is not demo (api-demo.bybit.com)" });
  if (!process.env.CMC_API_KEY) warnings.push({ code: "CMC_DISABLED", severity: "warn", message: "Missing CMC_API_KEY (universe disabled)" });
  return warnings;
}

// rolling liquidation feed (30m)
const liqEvents = new Map();
function pushLiq(ev) {
  const key = String(ev.symbol || "").toUpperCase();
  if (!key) return;
  const arr = liqEvents.get(key) || [];
  const usd = (Number(ev.price) || 0) * (Number(ev.size) || 0);
  arr.push({ ts: Number(ev.ts) || Date.now(), usd, side: ev.side });
  const cutoff = Date.now() - 30 * 60 * 1000;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
  liqEvents.set(key, arr);
}
const liqFeed = {
  getRollingUsd(symbol, windowMs = 15 * 60 * 1000) {
    const arr = liqEvents.get(String(symbol || "").toUpperCase()) || [];
    const cutoff = Date.now() - windowMs;
    let usd = 0; let count = 0;
    for (const x of arr) { if (x.ts >= cutoff) { usd += x.usd; count += 1; } }
    return { usd, count };
  },
};

const marketData = createMarketDataStore();
const marketBars = createMicroBarAggregator({
  bucketMs: 250,
  keepMs: 120000,
  onBar: (bar) => {
    const legacyType = bar.source === "BNB" ? "binance.bar" : "bybit.bar";
    broadcast({ type: legacyType, payload: bar });
  },
});
const leadLag = createLeadLag({ bucketMs: 250, maxLagMs: 5000, minSamples: 60, impulseZ: 2.0, minImpulses: 4 });
let lastLeadLagTop = [];

const bybit = createBybitPublicWs({
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  logger: app.log,
  enableLiquidations: true,
  onStatus: (s) => broadcast({ type: "bybit.status", payload: s }),
  onTicker: (t) => {
    const normalized = marketData.upsertTicker({ ...t, source: "BT" });
    if (!normalized) return;
    marketBars.ingest(normalized);
    broadcast({ type: "bybit.ticker", payload: normalized });
    broadcast({ type: "market.ticker", payload: normalized });
  },
  onLiquidation: (ev) => pushLiq(ev),
});
const binance = createBinanceSpotWs({
  symbols: bybit.getSymbols(),
  logger: app.log,
  onStatus: (s) => broadcast({ type: "binance.status", payload: s }),
  onTicker: (t) => {
    const normalized = marketData.upsertTicker({ ...t, source: "BNB" });
    if (!normalized) return;
    marketBars.ingest(normalized);
    broadcast({ type: "binance.ticker", payload: normalized });
    broadcast({ type: "market.ticker", payload: normalized });
  },
});

const tradeBaseUrl = process.env.BYBIT_TRADE_BASE_URL || "https://api-demo.bybit.com";
const privateRest = createBybitPrivateRest({
  apiKey: process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
  baseUrl: tradeBaseUrl,
  recvWindow: Number(process.env.BYBIT_RECV_WINDOW || 5000),
});
const instruments = createBybitInstrumentsCache({ baseUrl: tradeBaseUrl, privateRest, logger: app.log });
const tradeExecutor = createBybitTradeExecutor({ privateRest, instruments, logger: app.log });
const bybitRest = createBybitRest({ logger: app.log });

const paperTest = createPaperTest({
  getLeadLagTop: () => lastLeadLagTop,
  getTicker: (sym) => marketData.getTicker(sym, "BT") || null,
  getBars: (sym, n, source) => marketBars.getBars(sym, n, toTickerSourceCode(source) || "BT"),
  logger: app.log,
  onEvent: ({ type, payload }) => broadcast({ type, payload }),
});
const universe = createCmcBybitUniverse({ logger: app.log, minMarketCapUsd: 10_000_000, maxUniverse: 300 });
universe.start();
const klines = createBybitKlinesCache({ logger: app.log });
const pullbackTest = createPullbackTest({ universe, klines, trade: tradeExecutor, logger: app.log, onEvent: ({ type, payload }) => broadcast({ type, payload }) });
const rangeTest = createRangeMetricsTest({ universe, klines, bybitRest, liqFeed, trade: tradeExecutor, logger: app.log, onEvent: ({ type, payload }) => broadcast({ type, payload }) });

function getSnapshotPayload() {
  const bybitTickers = marketData.getTickersBySource("BT");
  const binanceTickers = marketData.getTickersBySource("BNB");
  return {
    now: Date.now(),
    bybit: bybit.getStatus(),
    binance: binance.getStatus(),
    symbols: bybit.getSymbols(),
    bybitTickers,
    binanceTickers,
    marketTickers: marketData.getTickersArray(),
    leadLagTop: lastLeadLagTop,
    paperState: paperTest.getState(),
    universeStatus: universe.getStatus(),
    pullbackState: pullbackTest.getState(),
    rangeState: rangeTest.getState(),
    tradeStatus: tradeStatus(tradeExecutor),
    warnings: tradeWarnings(tradeExecutor),
  };
}

function computeLeadLagTop() {
  const symbols = bybit.getSymbols();
  const eligible = symbols.filter((sym) => marketBars.getBars(sym, 70, "BNB").length >= 70);
  const top = leadLag.computeTop({
    symbols: eligible,
    getBars: (sym, n) => marketBars.getBars(sym, n, "BNB"),
    topN: 10,
    windowBars: 480,
  });
  lastLeadLagTop = top.map((r) => ({ ...r, leaderSrc: "binance", followerSrc: "binance", source: "BNB" }));
  broadcast({ type: "leadlag.top", payload: lastLeadLagTop });
}
setInterval(() => { try { computeLeadLagTop(); } catch {} }, 1000);
setInterval(() => broadcast({ type: "universe.status", payload: universe.getStatus() }), 30000);

app.get("/health", async () => ({ status: "ok" }));
app.get("/api/heartbeat", async () => ({ status: "ok", now: Date.now(), uptime_ms: Math.floor(process.uptime() * 1000) }));

app.get("/api/bybit/status", async () => bybit.getStatus());
app.get("/api/bybit/symbols", async () => ({ symbols: bybit.getSymbols() }));
app.get("/api/bybit/tickers", async () => bybit.getTickers());
app.get("/api/binance/status", async () => binance.getStatus());
app.get("/api/binance/symbols", async () => ({ symbols: binance.getSymbols() }));
app.get("/api/binance/tickers", async () => binance.getTickers());
app.get("/api/market/tickers", async () => ({ ts: Date.now(), tickers: marketData.getTickersArray() }));
app.get("/api/market/snapshot", async () => ({ ts: Date.now(), tickers: marketData.getTickersArray() }));
app.get("/api/leadlag/top", async () => ({ bucketMs: 250, top: lastLeadLagTop }));

app.get("/api/paper/state", async () => paperTest.getState());
app.get("/api/pullback/state", async () => pullbackTest.getState());
app.get("/api/range/state", async () => rangeTest.getState());
app.get("/api/universe/status", async () => universe.getStatus());
app.get("/api/universe/list", async () => ({ symbols: universe.getUniverse({ limit: 200 }) }));
app.post("/api/universe/refresh", async () => { await universe.refresh(); return universe.getStatus(); });
app.get("/api/trade/status", async () => ({ tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) }));

app.get("/ws", { websocket: true }, (conn) => {
  const ws = conn.socket;
  clients.add(ws);
  safeSend(ws, { type: "snapshot", payload: getSnapshotPayload() });
  safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (!msg?.type) return;
    if (msg.type === "ping") return safeSend(ws, { type: "pong", payload: { now: Date.now() } });
    if (msg.type === "getSnapshot") {
      safeSend(ws, { type: "snapshot", payload: getSnapshotPayload() });
      safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });
      return;
    }

    if (msg.type === "setSymbols") {
      const next = normalizeSymbols(msg.symbols);
      bybit.setSymbols(next);
      binance.setSymbols(next);
      safeSend(ws, { type: "setSymbols.ack", payload: { symbols: bybit.getSymbols() } });
      safeSend(ws, { type: "snapshot", payload: getSnapshotPayload() });
      safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });
      return;
    }

    if (msg.type === "getBars") {
      const symbol = String(msg.symbol || "").toUpperCase();
      const sourceCode = toTickerSourceCode(msg.source === "binance" ? "BNB" : msg.source);
      const source = toLegacySource(sourceCode || "BT");
      const requestedN = Number(msg.n);
      const n = Number.isFinite(requestedN) ? Math.max(1, Math.min(2000, Math.trunc(requestedN))) : 200;
      const bars = marketBars.getBars(symbol, n, sourceCode || "BT");
      safeSend(ws, { type: "bars", payload: { symbol, source, bars } });
      return;
    }

    if (msg.type === "getLeadLagTop") {
      const requestedN = Number(msg.n);
      const n = Number.isFinite(requestedN) ? Math.max(1, Math.min(50, Math.trunc(requestedN))) : 10;
      safeSend(ws, { type: "leadlag.top", payload: lastLeadLagTop.slice(0, n) });
      return;
    }

    if (msg.type === "startPaperTest") {
      safeSend(ws, { type: "paper.start.ack", payload: { ok: true } });
      paperTest.start({ preset: msg.preset && typeof msg.preset === "object" ? msg.preset : null });
      return;
    }

    if (msg.type === "stopPaperTest") {
      safeSend(ws, { type: "paper.stop.ack", payload: { ok: true } });
      paperTest.stop({ reason: "manual" });
      return;
    }

    if (msg.type === "getPaperState") {
      safeSend(ws, { type: "paper.state", payload: paperTest.getState() });
      return;
    }

    if (msg.type === "refreshUniverse") {
      safeSend(ws, { type: "universe.refresh.ack", payload: { ok: true } });
      universe.refresh().then(() => broadcast({ type: "universe.status", payload: universe.getStatus() }));
      return;
    }

    if (msg.type === "startPullbackTest") {
      const mode = msg.mode === "demo" ? "demo" : "paper";
      if (mode === "demo" && !tradeExecutor.enabled()) {
        const error = "Demo trade disabled (missing API keys)";
        safeSend(ws, { type: "pullback.start.ack", payload: { ok: false, error } });
        broadcast({ type: "pullback.log", payload: { t: Date.now(), level: "error", msg: error } });
        return;
      }
      safeSend(ws, { type: "pullback.start.ack", payload: { ok: true, mode } });
      pullbackTest.start({ mode, preset: msg.preset && typeof msg.preset === "object" ? msg.preset : null });
      return;
    }
    if (msg.type === "stopPullbackTest") { safeSend(ws, { type: "pullback.stop.ack", payload: { ok: true } }); pullbackTest.stop({ reason: "manual" }); return; }
    if (msg.type === "getPullbackState") return safeSend(ws, { type: "pullback.state", payload: pullbackTest.getState() });

    if (msg.type === "startRangeTest") {
      const mode = msg.mode === "demo" ? "demo" : "paper";
      if (mode === "demo" && !tradeExecutor.enabled()) {
        const error = "Demo trade disabled (missing API keys)";
        safeSend(ws, { type: "range.start.ack", payload: { ok: false, error } });
        broadcast({ type: "range.log", payload: { t: Date.now(), level: "error", msg: error } });
        return;
      }
      safeSend(ws, { type: "range.start.ack", payload: { ok: true, mode } });
      rangeTest.start({ mode, preset: msg.preset && typeof msg.preset === "object" ? msg.preset : null });
      return;
    }
    if (msg.type === "stopRangeTest") { safeSend(ws, { type: "range.stop.ack", payload: { ok: true } }); rangeTest.stop({ reason: "manual" }); return; }
    if (msg.type === "getRangeState") return safeSend(ws, { type: "range.state", payload: rangeTest.getState() });
  });

  ws.on("close", () => clients.delete(ws));
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`server on http://${HOST}:${PORT}`);

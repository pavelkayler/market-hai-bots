// backend/src/server.js
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";

import { createBybitPublicWs } from "./bybitPublicWs.js";
import { createBinanceSpotWs } from "./binanceSpotWs.js";
import { createMicroBarAggregator } from "./microBars.js";
import { createLeadLag } from "./leadLag.js";
import { createPaperTest } from "./paperTest.js";
import { createCmcBybitUniverse } from "./cmcBybitUniverse.js";
import { createBybitKlinesCache } from "./bybitKlinesCache.js";
import { createPullbackTest } from "./pullbackTest.js";

dotenv.config();

const app = Fastify({ logger: true });

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);

await app.register(cors, {
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
});

await app.register(websocket);

// --- HTTP ---
app.get("/health", async () => ({ status: "ok" }));

app.get("/api/heartbeat", async () => ({
  status: "ok",
  now: Date.now(),
  uptime_ms: Math.floor(process.uptime() * 1000),
}));

// --- WS clients ---
const clients = new Set();

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// --- Micro-bars 250ms (ring-buffer ~120s) ---
const bybitBars = createMicroBarAggregator({
  bucketMs: 250,
  keepMs: 120000,
  onBar: (bar) => {
    broadcast({ type: "bybit.bar", payload: bar });
  },
});

const binanceBars = createMicroBarAggregator({
  bucketMs: 250,
  keepMs: 120000,
  onBar: (bar) => {
    broadcast({ type: "binance.bar", payload: bar });
  },
});

// --- Lead-lag (corr + best lag + confirmation) ---
const leadLag = createLeadLag({
  bucketMs: 250,
  maxLagMs: 5000,
  // NOTE: relaxed for dev visibility; presets will later tighten.
  minSamples: 60,
  impulseZ: 2.0,
  minImpulses: 4,
});

let lastLeadLagTop = [];


// --- Bybit public WS client ---
const bybit = createBybitPublicWs({
  symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  logger: app.log,
  onStatus: (s) => {
    broadcast({ type: "bybit.status", payload: s });
  },
  onTicker: (t) => {
    bybitBars.ingest(t);
    broadcast({ type: "bybit.ticker", payload: t });
  },
});

// --- Binance spot WS client ---
const binance = createBinanceSpotWs({
  symbols: bybit.getSymbols(),
  logger: app.log,
  onStatus: (s) => {
    broadcast({ type: "binance.status", payload: s });
  },
  onTicker: (t) => {
    binanceBars.ingest(t);
    broadcast({ type: "binance.ticker", payload: t });
  },
});

// --- Paper Test (lead-lag paper trading; runs autonomously) ---
const paperTest = createPaperTest({
  getLeadLagTop: () => lastLeadLagTop,
  // Paper execution uses Bybit prices (same venue as future real trading).
  getTicker: (sym) => {
    const all = bybit.getTickers();
    return all && all[sym] ? all[sym] : null;
  },
  // Analytics bars: choose source per candidate (binance preferred if enough bars).
  getBars: (sym, n, source) => {
    const s = String(source || "bybit").toLowerCase();
    return s === "binance" ? binanceBars.getBars(sym, n) : bybitBars.getBars(sym, n);
  },
  logger: app.log,
  onEvent: ({ type, payload }) => {
    broadcast({ type, payload });
  },
});

// --- Universe (Bybit USDT perps with market cap > $10M via CoinMarketCap) ---
const universe = createCmcBybitUniverse({
  logger: app.log,
  minMarketCapUsd: 10_000_000,
  maxUniverse: 300,
});
universe.start();

// broadcast universe status (UI visibility)
setInterval(() => {
  try {
    broadcast({ type: "universe.status", payload: universe.getStatus() });
  } catch {}
}, 30000);

// --- Bybit klines cache (REST) for MTF strategies ---
const klines = createBybitKlinesCache({ logger: app.log });

// --- Pullback Test (MTF 1h/15m/5m) ---
const pullbackTest = createPullbackTest({
  universe,
  klines,
  logger: app.log,
  onEvent: ({ type, payload }) => broadcast({ type, payload }),
});


function computeLeadLagTop() {
  const symbols = bybit.getSymbols();
  const srcBySymbol = new Map();

  const minBarsPrefer = 70; // minSamples(60) + small cushion

  const pickBars = (sym, n) => {
    const bnb = binanceBars.getBars(sym, n);
    if (bnb && bnb.length >= minBarsPrefer) {
      srcBySymbol.set(sym, "binance");
      return bnb;
    }
    const bt = bybitBars.getBars(sym, n);
    srcBySymbol.set(sym, "bybit");
    return bt;
  };

  const top = leadLag.computeTop({
    symbols,
    getBars: (sym, n) => pickBars(sym, n),
    topN: 10,
    windowBars: 480,
  });

  // annotate sources used (binance preferred if enough bars)
  lastLeadLagTop = top.map((r) => ({
    ...r,
    leaderSrc: srcBySymbol.get(r.leader) || "bybit",
    followerSrc: srcBySymbol.get(r.follower) || "bybit",
  }));

  broadcast({ type: "leadlag.top", payload: lastLeadLagTop });
}

// compute + broadcast lead-lag once per second (visible in UI)
setInterval(() => {
  try {
    computeLeadLagTop();
  } catch (e) {
    app.log.warn({ err: e }, "leadlag compute failed");
  }
}, 1000);

// --- Debug endpoints ---
app.get("/api/bybit/status", async () => bybit.getStatus());
app.get("/api/bybit/symbols", async () => ({ symbols: bybit.getSymbols() }));
app.get("/api/bybit/tickers", async (req) => {
  const all = bybit.getTickers();
  const q = req.query?.symbols;
  if (!q) return all;

  const wanted = String(q)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const out = {};
  for (const sym of wanted) if (all[sym]) out[sym] = all[sym];
  return out;
});

app.get("/api/bybit/bars", async (req) => {
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const n = Math.min(2000, Math.max(1, Number(req.query?.n || 500)));
  return { symbol, bucketMs: 250, bars: bybitBars.getBars(symbol, n) };
});

app.get("/api/binance/status", async () => binance.getStatus());
app.get("/api/binance/symbols", async () => ({ symbols: binance.getSymbols() }));
app.get("/api/binance/tickers", async (req) => {
  const all = binance.getTickers();
  const q = req.query?.symbols;
  if (!q) return all;

  const wanted = String(q)
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const out = {};
  for (const sym of wanted) if (all[sym]) out[sym] = all[sym];
  return out;
});

app.get("/api/binance/bars", async (req) => {
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const n = Math.min(2000, Math.max(1, Number(req.query?.n || 500)));
  return { symbol, bucketMs: 250, bars: binanceBars.getBars(symbol, n) };
});

app.get("/api/leadlag/top", async (req) => {
  const n = Math.min(50, Math.max(1, Number(req.query?.n || 10)));
  // return the latest computed snapshot (avoid heavy compute per HTTP request)
  return { bucketMs: 250, top: lastLeadLagTop.slice(0, n) };
});

app.get("/api/paper/state", async () => {
  return paperTest.getState();
});

// Universe + Pullback
app.get("/api/universe/status", async () => universe.getStatus());
app.post("/api/universe/refresh", async () => {
  const s = await universe.refresh();
  return universe.getStatus();
});

app.get("/api/pullback/state", async () => {
  return pullbackTest.getState();
});


// --- WS endpoint ---
app.get("/ws", { websocket: true }, (conn) => {
  const ws = conn.socket;
  clients.add(ws);

  // snapshot сразу при подключении
  safeSend(ws, {
    type: "snapshot",
    payload: {
      now: Date.now(),
      bybit: bybit.getStatus(),
      binance: binance.getStatus(),
      symbols: bybit.getSymbols(),
      bybitTickers: bybit.getTickers(),
      binanceTickers: binance.getTickers(),
      leadLagTop: lastLeadLagTop,
      paperState: paperTest.getState(),
      universeStatus: universe.getStatus(),
      pullbackState: pullbackTest.getState(),
    },
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", payload: { now: Date.now() } });
      return;
    }

    if (msg.type === "getSnapshot") {
      safeSend(ws, {
        type: "snapshot",
        payload: {
          now: Date.now(),
          bybit: bybit.getStatus(),
          binance: binance.getStatus(),
          symbols: bybit.getSymbols(),
          bybitTickers: bybit.getTickers(),
          binanceTickers: binance.getTickers(),
      leadLagTop: lastLeadLagTop,
      paperState: paperTest.getState(),
      universeStatus: universe.getStatus(),
      pullbackState: pullbackTest.getState(),
        },
      });
      return;
    }

    if (msg.type === "setSymbols") {
      const arr = Array.isArray(msg.symbols) ? msg.symbols : [];
      const next = arr.slice(0, 10);

      bybit.setSymbols(next);
      binance.setSymbols(next);

      safeSend(ws, {
        type: "setSymbols.ack",
        payload: { ok: true, symbols: bybit.getSymbols() },
      });

      setTimeout(() => {
        try {
          computeLeadLagTop();
        } catch {}
      }, 250);
      return;
    }

    if (msg.type === "getBars") {
      const symbol = String(msg.symbol || "BTCUSDT").toUpperCase();
      const n = Math.min(2000, Math.max(1, Number(msg.n || 500)));
      const source = String(msg.source || "bybit").toLowerCase();
      const bars = source === "binance" ? binanceBars.getBars(symbol, n) : bybitBars.getBars(symbol, n);
      safeSend(ws, {
        type: "bars",
        payload: { symbol, bucketMs: 250, source, bars },
      });
      return;
    }

    if (msg.type === "getLeadLagTop") {
      const n = Math.min(50, Math.max(1, Number(msg.n || 10)));
      safeSend(ws, {
        type: "leadlag.top",
        payload: lastLeadLagTop.slice(0, n),
      });
      return;
    }

    if (msg.type === "startPaperTest") {
      // Fast ACK; the PaperTest moves STARTING->RUNNING asynchronously via events/logs.
      safeSend(ws, { type: "paper.start.ack", payload: { ok: true } });
      const presetOverride = (msg.preset && typeof msg.preset === "object") ? msg.preset : null;
      paperTest.start({ preset: presetOverride });
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

    // --- Universe (CMC+Bybit) ---
    if (msg.type === "refreshUniverse") {
      safeSend(ws, { type: "universe.refresh.ack", payload: { ok: true } });
      universe.refresh().then(() => {
        const s = universe.getStatus();
        safeSend(ws, { type: "universe.status", payload: s });
        broadcast({ type: "universe.status", payload: s });
      }).catch((e) => {
        const s = universe.getStatus();
        safeSend(ws, { type: "universe.status", payload: s });
      });
      return;
    }

    // --- Pullback Test (MTF 1h/15m/5m) ---
    if (msg.type === "startPullbackTest") {
      safeSend(ws, { type: "pullback.start.ack", payload: { ok: true } });
      const presetOverride = (msg.preset && typeof msg.preset === "object") ? msg.preset : null;
      pullbackTest.start({ preset: presetOverride });
      return;
    }

    if (msg.type === "stopPullbackTest") {
      safeSend(ws, { type: "pullback.stop.ack", payload: { ok: true } });
      pullbackTest.stop({ reason: "manual" });
      return;
    }

    if (msg.type === "getPullbackState") {
      safeSend(ws, { type: "pullback.state", payload: pullbackTest.getState() });
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`server on http://${HOST}:${PORT}`);

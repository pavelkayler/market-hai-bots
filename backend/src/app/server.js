// backend/src/server.js
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import WebSocket from "ws";

import { createBybitPublicWs } from "../bybitPublicWs.js";
import { createMicroBarAggregator } from "../microBars.js";
import { createLeadLag } from "../leadLag.js";
import { evaluateTradeReady } from "../leadLagReadiness.js";
import { createPaperTest } from "../paperTest.js";
import { createCmcBybitUniverse } from "../cmcBybitUniverse.js";
import { createBybitKlinesCache } from "../bybitKlinesCache.js";
import { createRangeMetricsTest } from "../rangeMetricsTest.js";
import { createBybitPrivateRest } from "../bybitPrivateRest.js";
import { createBybitInstrumentsCache } from "../bybitInstrumentsCache.js";
import { createBybitTradeExecutor } from "../bybitTradeExecutor.js";
import { createBybitRest } from "../bybitRest.js";
import { createMarketDataStore } from "../marketDataStore.js";
import { createPresetsStore } from "../presetsStore.js";
import { createImpulseBot } from "../impulseBot.js";
import { createJournalStore } from "../journalStore.js";
import { createSubscriptionManager } from "../subscriptionManager.js";

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

function sendEvent(ws, topic, payload) {
  safeSend(ws, { type: "event", topic, payload });
}

function broadcastEvent(topic, payload) {
  broadcast({ type: "event", topic, payload });
}

const DEFAULT_SYMBOL_LIMIT = Number(process.env.DEFAULT_SYMBOL_LIMIT || 500);

const DEFAULT_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","TRXUSDT","AVAXUSDT","LINKUSDT",
  "DOTUSDT","MATICUSDT","TONUSDT","LTCUSDT","BCHUSDT","NEARUSDT","APTUSDT","ARBUSDT","OPUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","HBARUSDT","XLMUSDT","SUIUSDT","SEIUSDT","INJUSDT","AAVEUSDT","UNIUSDT","ALGOUSDT",
  "RUNEUSDT","GALAUSDT","PEPEUSDT","SHIBUSDT","WIFUSDT","TIAUSDT","JUPUSDT","PYTHUSDT","CRVUSDT","MKRUSDT",
  "SNXUSDT","DYDXUSDT","LDOUSDT","ICPUSDT","FLOWUSDT","EGLDUSDT","KASUSDT","FTMUSDT","SANDUSDT","MANAUSDT"
];

function normalizeSymbols(symbols, maxSymbols = 100) {
  if (!Array.isArray(symbols)) return [];
  const uniq = new Set();
  for (const sym of symbols) {
    if (typeof sym !== "string") continue;
    const upper = sym.trim().toUpperCase();
    if (!upper || upper.includes("-")) continue;
    const normalized = upper.replace(/\//g, "");
    if (!normalized) continue;
    uniq.add(normalized);
    if (uniq.size >= maxSymbols) break;
  }
  return [...uniq];
}

const TRADE_REAL_ENABLED = process.env.TRADE_REAL_ENABLED === "1";

function tradeStatus(tradeExecutor) {
  const baseUrl = process.env.BYBIT_TRADE_BASE_URL || "https://api-demo.bybit.com";
  const recvWindow = Number(process.env.BYBIT_RECV_WINDOW || 5000);
  const enabled = Boolean(tradeExecutor?.enabled?.());
  const executionMode = tradeExecutor?.getExecutionMode?.() || "paper";
  const realAllowed = TRADE_REAL_ENABLED;
  const tradeEnabledByMode = executionMode === "paper" ? true : enabled && (executionMode !== "real" || realAllowed);
  return {
    enabled: tradeEnabledByMode,
    status: tradeEnabledByMode ? "TRADE_ENABLED" : "TRADE_DISABLED",
    demo: /api-demo\.bybit\.com/i.test(baseUrl),
    real: /api\.bybit\.com/i.test(baseUrl),
    baseUrl,
    recvWindow,
    executionMode,
    killSwitch: Boolean(tradeExecutor?.getKillSwitch?.()),
    realAllowed,
    guardrails: {
      maxNotionalUsd: Number(process.env.TRADE_MAX_NOTIONAL || 100),
      maxLeverage: Number(process.env.TRADE_MAX_LEVERAGE || 10),
      maxActivePositions: Number(process.env.TRADE_MAX_ACTIVE_POSITIONS || 1),
    },
  };
}

function tradeWarnings(tradeExecutor) {
  const warnings = [];
  const ts = tradeStatus(tradeExecutor);
  if (ts.executionMode !== "paper" && !Boolean(tradeExecutor?.enabled?.())) warnings.push({ code: "TRADE_DISABLED", severity: "error", message: "Missing BYBIT_API_KEY/BYBIT_API_SECRET" });
  if (ts.executionMode === "real" && !ts.realAllowed) warnings.push({ code: "REAL_DISABLED", severity: "error", message: "REAL trading requires TRADE_REAL_ENABLED=1" });
  if (ts.executionMode === "demo" && !ts.demo) warnings.push({ code: "TRADE_BASE_URL", severity: "warn", message: "Demo mode requires BYBIT_TRADE_BASE_URL=api-demo.bybit.com" });
  if (ts.executionMode === "real" && !ts.real) warnings.push({ code: "TRADE_BASE_URL", severity: "warn", message: "Real mode requires BYBIT_TRADE_BASE_URL=api.bybit.com" });
  if (!(process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY)) warnings.push({ code: "CMC_DISABLED", severity: "warn", message: "Missing CMC_API_KEY (universe disabled)" });
  return warnings;
}


function applyPresetGuardrails(preset) {
  const params = preset?.params || {};
  tradeExecutor.setGuardrails?.({
    maxNotional: Number(params.maxNotionalUsd || 100),
    maxLeverage: Number(params.maxLeverage || 10),
    maxActivePositions: Number(params.maxActivePositions || 1),
  });
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
    broadcast({ type: "bybit.bar", payload: bar });
  },
});
const leadLag = createLeadLag({ bucketMs: 250, maxLagMs: 5000, minSamples: 200, impulseZ: 2.0, minImpulses: 5 });
let lastLeadLagTop = [];
let leadLagSearchActive = false;

const bybit = createBybitPublicWs({
  symbols: [],
  logger: app.log,
  enableLiquidations: true,
  onStatus: (s) => broadcast({ type: "bybit.status", payload: s }),
  onTicker: (t) => {
    const normalized = marketData.upsertTicker({ ...t, source: "BT" });
    if (!normalized) return;
    marketBars.ingest(normalized);
    broadcast({ type: "bybit.ticker", payload: normalized });
    broadcast({ type: "market.ticker", payload: normalized });
    broadcastEvent("market.ticker", normalized);
  },
  onLiquidation: (ev) => pushLiq(ev),
});

const subscriptions = createSubscriptionManager({ bybit, logger: app.log });

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
const presetsStore = createPresetsStore({ logger: app.log });
const journalStore = createJournalStore({ logger: app.log });

const openByBotSymbol = new Map();
function rememberOpenTrade(botName, trade) {
  if (!trade?.symbol) return;
  openByBotSymbol.set(`${botName}:${String(trade.symbol).toUpperCase()}`, trade);
}

function emitJournalFromClose(botName, trade) {
  if (!trade?.symbol) return;
  const symbol = String(trade.symbol).toUpperCase();
  const key = `${botName}:${symbol}`;
  const opened = openByBotSymbol.get(key) || {};
  openByBotSymbol.delete(key);
  const entryPrice = Number(opened.entry || trade.entry || trade.entryPrice || 0);
  const exitPrice = Number(trade.exit || trade.exitPrice || entryPrice);
  const qty = Number(opened.qty || trade.qty || (entryPrice > 0 ? 100 / entryPrice : 0));
  const pnlUsdt = Number(trade.pnlUSDT || trade.pnlUsdt || 0);
  const roiPct = Number(trade.roiPct || (entryPrice > 0 ? (pnlUsdt / Math.max(1, qty * entryPrice)) * 100 : 0));
  journalStore.append({
    botName,
    symbol,
    side: trade.side || opened.side || "",
    mode: trade.mode || opened.mode || "paper",
    openedAt: Number(opened.ts || opened.openedAt || trade.ts || Date.now()),
    closedAt: Number(trade.ts || Date.now()),
    entryPrice,
    exitPrice,
    tpLevels: opened.tp ? [opened.tp] : opened.tpPrices || [],
    slLevel: Number(opened.sl || opened.slPrice || 0),
    qty,
    notionalUsd: Number(opened.notionalUsd || qty * entryPrice || 0),
    leverage: Number(opened.leverage || 1),
    pnlUsdt,
    roiPct,
    reasonOpen: opened.reasonOpen || "signal",
    reasonClose: trade.reason || trade.exitReason || "close",
    snapshot: {
      priceDelta: trade.priceDeltaPct,
      oiDelta: trade.oiDeltaPct,
    },
  });
}

const paperTest = createPaperTest({
  getLeadLagTop: () => lastLeadLagTop,
  getMarketTicker: (symbol, source) => marketData.getTicker(symbol, source),
  getUniverseSymbols: () => universe.getUniverse({ limit: 500 }).symbols,
  presetsStore,
  logger: app.log,
  onEvent: ({ type, payload }) => {
    broadcast({ type, payload });
    if (type === "leadlag.trade") {
      if (String(payload?.event || "").toUpperCase() === "OPEN") rememberOpenTrade("LeadLag", payload);
      else emitJournalFromClose("LeadLag", payload);
    }
  },
});
const universe = createCmcBybitUniverse({
  logger: app.log,
  minMarketCapUsd: 10_000_000,
  maxUniverse: 500,
  getBybitFeedSymbols: () => bybit.getSymbols(),
  onUniverseUpdated: (payload) => {
    broadcastEvent("universe.updated", payload);
  },
});
universe.start();

function universeGet() {
  return universe.getUniverse({ limit: 80 }).symbols || [];
}

function pickMostVolatileSymbols(limit = 100) {
  const rows = marketData.getTickersArray().filter((t) => t?.source === "BT" && t?.symbol && !String(t.symbol).includes("-"));
  const scored = rows.map((t) => {
    const bars = marketBars.getBars(t.symbol, 60, "BT");
    const first = Number(bars?.[0]?.c || bars?.[0]?.close);
    const last = Number(bars?.[bars.length - 1]?.c || bars?.[bars.length - 1]?.close);
    const score = Number.isFinite(first) && Number.isFinite(last) && first !== 0 ? Math.abs((last - first) / Math.abs(first)) : 0;
    return { symbol: t.symbol, score };
  }).sort((a,b)=>b.score-a.score);
  return scored.slice(0, limit).map((x) => x.symbol);
}

const klines = createBybitKlinesCache({ logger: app.log });
const rangeTest = createRangeMetricsTest({ universe, klines, bybitRest, liqFeed, trade: tradeExecutor, logger: app.log, onEvent: ({ type, payload }) => {
  broadcast({ type, payload });
  if (type === "range.trade") {
    if (String(payload?.event || "").toUpperCase() === "OPEN") rememberOpenTrade("RangeMetrics", payload);
    else emitJournalFromClose("RangeMetrics", payload);
  }
} });
const impulseBot = createImpulseBot({
  getSymbols: () => bybit.getSymbols(),
  getCapsUniverse: () => universe.getUniverse({ limit: 500 }).symbols,
  getCandles: ({ symbol, interval, limit }) => klines.getCandles({ symbol, interval, limit }),
  getOi: ({ symbol, interval, limit }) => bybitRest.getOpenInterest({ symbol, interval: String(interval || '5'), limit }),
  logger: app.log,
  onEvent: ({ type, payload }) => {
    broadcast({ type, payload });
    if (type === "impulse.trade") {
      if (String(payload?.event || "").toUpperCase() === "OPEN") rememberOpenTrade("Impulse", payload);
      else emitJournalFromClose("Impulse", payload);
    }
  },
});

async function getTradeSnapshot(symbol) {
  if (!tradeExecutor?.enabled?.()) return { positions: [], orders: [] };
  try {
    const [positions, orders] = await Promise.all([
      tradeExecutor.getPositions({ symbol }),
      tradeExecutor.getOpenOrders({ symbol }),
    ]);
    return { positions, orders };
  } catch {
    return { positions: [], orders: [] };
  }
}

function getSnapshotPayload() {
  const bybitTickers = marketData.getTickersBySource("BT");
  return {
    now: Date.now(),
    bybit: bybit.getStatus(),
    symbols: bybit.getSymbols(),
    symbolLimit: DEFAULT_SYMBOL_LIMIT,
    bybitTickers,
    marketTickers: marketData.getTickersArray(),
    leadLagTop: lastLeadLagTop,
    paperState: paperTest.getState(),
    leadlagState: paperTest.getState(),
    universeStatus: universe.getStatus(),
    rangeState: rangeTest.getState(),
    impulseState: impulseBot.getState(),
    botsOverview: getBotsOverview(),
    watchlists: {
      leadlag: bybit.getSymbols().slice(0, 100),
      range: pickMostVolatileSymbols(500),
      impulse: universe.getUniverse({ limit: 500 }).symbols,
    },
    tradeStatus: tradeStatus(tradeExecutor),
    warnings: tradeWarnings(tradeExecutor),
    universe: universe.getStatus().universe,
    presets: presetsStore.getState(),
    tradePositions: [],
    tradeOrders: [],
  };
}

function toBotPnl(state) {
  if (!state || typeof state !== "object") return 0;
  if (Number.isFinite(Number(state?.stats?.pnlUSDT))) return Number(state.stats.pnlUSDT);
  const trades = Array.isArray(state?.trades) ? state.trades : [];
  const closeTrades = trades.filter((t) => String(t?.event || "").toUpperCase() === "CLOSE");
  const sum = closeTrades.reduce((acc, t) => acc + (Number(t?.pnlUSDT) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

function getBotsOverview() {
  const leadlagState = paperTest.getState?.({ includeHistory: false }) || paperTest.getState?.() || {};
  const rangeState = rangeTest.getState?.() || {};
  const impulseState = impulseBot.getState?.() || {};
  const paperBalance = Number(process.env.PAPER_WALLET_BALANCE || 10000);
  const agg = journalStore.getAggregates();
  return {
    ts: Date.now(),
    paperBalance,
    bots: [
      { name: "LeadLag", status: leadlagState.status || "STOPPED", pnl: Number(agg?.LeadLag?.pnlUsdt ?? toBotPnl(leadlagState)), startedAt: leadlagState.startedAt || null },
      { name: "RangeMetrics", status: rangeState.status || "STOPPED", pnl: Number(agg?.RangeMetrics?.pnlUsdt ?? toBotPnl(rangeState)), startedAt: rangeState.startedAt || null },
      { name: "Impulse", status: impulseState.status || "STOPPED", pnl: Number(agg?.Impulse?.pnlUsdt ?? toBotPnl(impulseState)), startedAt: impulseState.startedAt || null },
    ],
  };
}

function computeLeadLagTop() {
  const symbols = bybit.getSymbols();
  const leaders = ["BTCUSDT", "ETHUSDT", "SOLUSDT"].filter((sym) => symbols.includes(sym));
  const followers = symbols.filter((sym) => marketBars.getBars(sym, 200, "BT").length >= 30);
  const eligible = [...new Set([...leaders, ...followers])];
  const activePreset = presetsStore.getActivePreset();
  const params = activePreset?.params || {};
  const excludedCoins = Array.isArray(activePreset?.excludedCoins) ? activePreset.excludedCoins : [];

  const top = leadLag.computeTop({
    leaders,
    symbols: eligible,
    getBars: (sym, n) => marketBars.getBars(sym, n, "BT"),
    topN: 10,
    windowBars: 480,
    params,
  });

  lastLeadLagTop = top.map((r) => {
    const readiness = evaluateTradeReady({
      row: r,
      preset: activePreset,
      excludedCoins,
      lastTradeAt: paperTest.getState({ includeHistory: false })?.position?.openedAt || 0,
      getBars: (sym, n, source) => marketBars.getBars(sym, n, source),
      bucketMs: 250,
    });
    return {
      ...r,
      leaderSrc: "bybit",
      followerSrc: "bybit",
      source: "BT",
      tradeReady: readiness.tradeReady,
      blockers: readiness.blockers,
    };
  });

  paperTest.setSearchRows?.(lastLeadLagTop);
  broadcast({ type: "leadlag.top", payload: lastLeadLagTop });
  broadcastEvent("leadlag.top", { ts: Date.now(), source: "BT", rows: lastLeadLagTop });
}
function shouldComputeLeadLagTop() {
  if (leadLagSearchActive) return true;
  const llState = paperTest.getState?.({ includeHistory: false }) || {};
  const running = llState?.status === "RUNNING";
  const manualTrading = Boolean(llState?.manual?.enabled);
  const autoTopTrading = running && !manualTrading;
  return autoTopTrading;
}
setInterval(() => {
  try {
    if (!shouldComputeLeadLagTop()) return;
    computeLeadLagTop();
  } catch {}
}, 1000);
setInterval(() => broadcast({ type: "universe.status", payload: universe.getStatus() }), 30000);
setInterval(() => broadcastEvent("bots.overview", getBotsOverview()), 2000);
setInterval(async () => {
  try {
    const ts = tradeStatus(tradeExecutor);
    if (!["demo", "real"].includes(ts.executionMode) || !ts.enabled) return;
    const symbol = (rangeTest.getState?.().position?.symbol || "BTCUSDT").toUpperCase();
    const snap = await getTradeSnapshot(symbol);
    broadcastEvent("trade.positions", { ts: Date.now(), symbol, positions: snap.positions || [] });
    broadcastEvent("trade.orders", { ts: Date.now(), symbol, orders: snap.orders || [] });
  } catch {}
}, 3000);

app.get("/health", async () => ({ status: "ok" }));
app.get("/api/heartbeat", async () => ({ status: "ok", now: Date.now(), uptime_ms: Math.floor(process.uptime() * 1000) }));

app.get("/api/bybit/status", async () => bybit.getStatus());
app.get("/api/bybit/symbols", async () => ({ symbols: bybit.getSymbols() }));
app.get("/api/bybit/tickers", async () => bybit.getTickers());
app.get("/api/market/tickers", async () => ({ ts: Date.now(), tickers: marketData.getTickersArray() }));
app.get("/api/market/snapshot", async () => ({ ts: Date.now(), tickers: marketData.getTickersArray() }));
app.get("/api/subscriptions", async () => subscriptions.getState());
app.get("/api/leadlag/top", async () => ({ bucketMs: 250, top: lastLeadLagTop }));

app.get("/api/paper/state", async () => paperTest.getState());
app.get("/api/leadlag/state", async () => paperTest.getState());
app.get("/api/range/state", async () => rangeTest.getState());
app.get("/api/impulse/state", async () => impulseBot.getState());
app.get("/api/universe/status", async () => universe.getStatus());
app.get("/api/universe/list", async () => ({ symbols: universe.getUniverse({ limit: 200 }).symbols }));
app.get("/api/universe", async () => universe.getUniverse({ limit: 300 }));
app.post("/api/universe/refresh", async () => { await universe.refresh(); return universe.getStatus(); });
app.get("/api/trade/status", async () => ({ tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) }));
app.get("/api/trade/state", async () => ({
  executionMode: tradeExecutor.getExecutionMode(),
  tradeStatus: tradeStatus(tradeExecutor),
  warnings: tradeWarnings(tradeExecutor),
  killSwitch: tradeExecutor.getKillSwitch(),
  activeSymbol: null,
  lastError: null,
}));
app.get("/api/trade/positions", async (req) => {
  const symbol = String(req.query?.symbol || "").toUpperCase() || undefined;
  const snap = await getTradeSnapshot(symbol);
  return { positions: snap.positions, tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) };
});
app.get("/api/trade/openOrders", async (req) => {
  const symbol = String(req.query?.symbol || "").toUpperCase() || undefined;
  const snap = await getTradeSnapshot(symbol);
  return { orders: snap.orders, tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) };
});
app.get("/api/trade/orders", async (req) => {
  const symbol = String(req.query?.symbol || "").toUpperCase() || undefined;
  const snap = await getTradeSnapshot(symbol);
  return { orders: snap.orders, positions: snap.positions, tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) };
});
app.get("/api/trade/history", async (req) => {
  if (!tradeExecutor.enabled()) return { history: [] };
  try {
    return { history: await tradeExecutor.getClosedPnl({ limit: Number(req.query?.limit || 200) }) };
  } catch {
    return { history: [] };
  }
});
app.get("/api/journal", async (req) => ({
  rows: journalStore.list({ botName: req.query?.botName ? String(req.query.botName) : null, mode: req.query?.mode ? String(req.query.mode) : null, limit: Number(req.query?.limit || 200) }),
  aggregates: journalStore.getAggregates(),
}));
app.post("/api/trade/killswitch", async (req) => {
  const enabled = tradeExecutor.setKillSwitch(Boolean(req.body?.enabled));
  broadcastEvent("trade.killswitch", { enabled });
  return { ok: true, enabled };
});
app.get("/api/presets", async () => presetsStore.getState());
app.post("/api/presets", async (req) => {
  const preset = presetsStore.createPreset(req.body || {});
  const payload = presetsStore.getState();
  broadcastEvent("presets.updated", payload);
  return { ok: true, preset, ...payload };
});
app.put("/api/presets/:id", async (req) => {
  const updated = presetsStore.updatePreset(req.params.id, req.body || {});
  if (!updated) return { ok: false, error: "NOT_FOUND" };
  const payload = presetsStore.getState();
  broadcastEvent("presets.updated", payload);
  return { ok: true, preset: updated, ...payload };
});
app.delete("/api/presets/:id", async (req) => {
  const ok = presetsStore.deletePreset(req.params.id);
  const payload = presetsStore.getState();
  broadcastEvent("presets.updated", payload);
  return { ok, ...payload };
});
app.post("/api/presets/:id/select", async (req) => {
  const ok = presetsStore.selectPreset(req.params.id);
  const payload = { activePresetId: presetsStore.getState().activePresetId };
  broadcastEvent("preset.selected", payload);
  broadcastEvent("presets.updated", presetsStore.getState());
  return { ok, ...payload };
});


const statusWatchers = new Map();
function getBybitHealth() {
  const t = marketData.getTicker('BTCUSDT', 'BT');
  const now = Date.now();
  const lastTickerAt = Number(t?.ts || 0) || null;
  const lastBybitTs = Number(t?.bybitTs || t?.ts || 0) || null;
  const ageMs = lastTickerAt ? Math.max(0, now - lastTickerAt) : null;
  return {
    status: bybit.getStatus?.()?.status || 'disconnected',
    url: bybit.getStatus?.()?.url || null,
    symbol: 'BTCUSDT',
    lastTickerAt,
    lastBybitTs,
    ageMs,
  };
}
function stopStatusWatcher(ws) {
  const st = statusWatchers.get(ws);
  if (!st) return;
  if (st.timer) clearInterval(st.timer);
  statusWatchers.delete(ws);
  subscriptions.releaseFeed(`status-page:${st.id}`);
}
function startStatusWatcher(ws) {
  const existing = statusWatchers.get(ws);
  if (existing) return;
  const id = Math.random().toString(36).slice(2);
  subscriptions.requestFeed(`status-page:${id}`, { bybitSymbols: ['BTCUSDT'], streams: ['ticker'] });
  const st = { id, lastSeenAt: Date.now(), rttMs: null, lastPongAt: null, timer: null };
  st.timer = setInterval(() => {
    sendEvent(ws, 'status.health', {
      backendWs: { connected: true, lastSeenAt: st.lastSeenAt, rttMs: st.rttMs, lastPongAt: st.lastPongAt },
      bybitWs: getBybitHealth(),
    });
  }, 5000);
  statusWatchers.set(ws, st);
}

app.get("/ws", { websocket: true }, (conn) => {
  const ws = conn.socket;
  clients.add(ws);
  Promise.resolve(getTradeSnapshot()).then((tradeSnap) => {
    safeSend(ws, { type: "snapshot", payload: { ...getSnapshotPayload(), tradePositions: tradeSnap.positions, tradeOrders: tradeSnap.orders } });
  });
  safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });
  sendEvent(ws, "market.snapshot", { tickers: marketData.getTickersArray(), ts: Date.now() });

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (!msg?.type) return;
    if (msg.type === "ping") return safeSend(ws, { type: "pong", payload: { now: Date.now() } });
    if (msg.type === "status.watch") {
      if (msg?.active || msg?.payload?.active) startStatusWatcher(ws);
      else stopStatusWatcher(ws);
      safeSend(ws, { type: "status.watch.ack", payload: { active: Boolean(statusWatchers.get(ws)) } });
      return;
    }
    if (msg.type === "status.ping") {
      const ts = Number(msg?.ts || msg?.payload?.ts || Date.now());
      const st = statusWatchers.get(ws);
      if (st) { st.lastSeenAt = Date.now(); st.rttMs = Math.max(0, Date.now() - ts); st.lastPongAt = Date.now(); }
      safeSend(ws, { type: "status.pong", payload: { tsEcho: ts, now: Date.now() } });
      return;
    }
    if (msg.type === "getSnapshot") {
      Promise.resolve(getTradeSnapshot()).then((tradeSnap) => safeSend(ws, { type: "snapshot", payload: { ...getSnapshotPayload(), tradePositions: tradeSnap.positions, tradeOrders: tradeSnap.orders } }));
      safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });
      sendEvent(ws, "market.snapshot", { tickers: marketData.getTickersArray(), ts: Date.now() });
      return;
    }

    if (msg.type === "setSymbols") {
      const maxSymbols = Number(msg.maxSymbols || 100);
      const next = normalizeSymbols(msg.symbols, Math.max(1, Math.min(100, maxSymbols)));
      subscriptions.requestFeed("manual-watchlist", { bybitSymbols: next, streams: ["ticker"] });
      safeSend(ws, { type: "setSymbols.ack", payload: { symbols: next } });
      Promise.resolve(getTradeSnapshot()).then((tradeSnap) => safeSend(ws, { type: "snapshot", payload: { ...getSnapshotPayload(), tradePositions: tradeSnap.positions, tradeOrders: tradeSnap.orders } }));
      safeSend(ws, { type: "market.snapshot", payload: { tickers: marketData.getTickersArray(), ts: Date.now() } });
      sendEvent(ws, "market.snapshot", { tickers: marketData.getTickersArray(), ts: Date.now() });
      return;
    }

    if (msg.type === "getBars") {
      const symbol = String(msg.symbol || "").toUpperCase();
      const sourceCode = "BT";
      const requestedN = Number(msg.n);
      const n = Number.isFinite(requestedN) ? Math.max(1, Math.min(2000, Math.trunc(requestedN))) : 200;
      const bars = marketBars.getBars(symbol, n, sourceCode);
      const payload = { symbol, source: sourceCode, bars };
      if (!bars.length) payload.warning = "NO_BARS";
      safeSend(ws, { type: "bars", payload });
      return;
    }

    if (msg.type === "getLeadLagTop") {
      const requestedN = Number(msg.n);
      const n = Number.isFinite(requestedN) ? Math.max(1, Math.min(50, Math.trunc(requestedN))) : 10;
      safeSend(ws, { type: "leadlag.top", payload: lastLeadLagTop.slice(0, n) });
      return;
    }

    if (msg.type === "startPaperTest" || msg.type === "startLeadLag") {
      const presetId = msg.presetId || presetsStore.getState().activePresetId;
      const settings = msg?.settings && typeof msg.settings === "object" ? msg.settings : null;
      applyPresetGuardrails(presetsStore.getPresetById?.(presetId) || presetsStore.getActivePreset?.());
      const leader = String(settings?.leaderSymbol || "BTCUSDT").toUpperCase();
      const follower = String(settings?.followerSymbol || "ETHUSDT").toUpperCase();
      subscriptions.requestFeed("leadlag-trading", { bybitSymbols: [leader, follower], streams: ["ticker"] });
      const result = paperTest.start({ presetId, mode: msg.mode || "paper", settings });
      const currentState = paperTest.getState();
      safeSend(ws, { type: "leadlag.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      safeSend(ws, { type: "paper.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      return;
    }

    if (msg.type === "stopPaperTest" || msg.type === "stopLeadLag") {
      safeSend(ws, { type: "leadlag.stop.ack", payload: { ok: true } });
      safeSend(ws, { type: "paper.stop.ack", payload: { ok: true } });
      paperTest.stop({ reason: "manual" });
      subscriptions.releaseFeed("leadlag-trading");
      return;
    }


    if (msg.type === "startLeadLagSearch") {
      const universe = normalizeSymbols(msg.symbols || universeGet(), 80);
      subscriptions.requestFeed("leadlag-search", { bybitSymbols: universe, streams: ["ticker"] });
      leadLagSearchActive = true;
      safeSend(ws, { type: "leadlag.search.ack", payload: { ok: true, active: true } });
      return;
    }
    if (msg.type === "stopLeadLagSearch") {
      subscriptions.releaseFeed("leadlag-search");
      leadLagSearchActive = false;
      safeSend(ws, { type: "leadlag.search.ack", payload: { ok: true, active: false } });
      return;
    }

    if (msg.type === "resetLeadLag") {
      paperTest.stop({ reason: "reset" });
      subscriptions.releaseFeed("leadlag-trading");
      const payload = paperTest.reset();
      safeSend(ws, { type: "leadlag.reset.ack", payload });
      return;
    }

    if (msg.type === "getPaperState" || msg.type === "getLeadLagState") {
      const state = paperTest.getState();
      safeSend(ws, { type: "leadlag.state", payload: state });
      safeSend(ws, { type: "paper.state", payload: state });
      return;
    }

    if (msg.type === "leadlag.setAutoTuneConfig") {
      const payload = paperTest.setAutoTuneConfig(msg?.payload && typeof msg.payload === 'object' ? msg.payload : msg?.settings && typeof msg.settings === 'object' ? msg.settings : {});
      safeSend(ws, { type: "leadlag.autotune.ack", payload: { ok: true, config: payload?.autoTuneConfig || null } });
      safeSend(ws, { type: "leadlag.state", payload });
      return;
    }

    if (msg.type === "leadlag.clearLearningLog") {
      const payload = paperTest.clearLearningLog();
      safeSend(ws, { type: "leadlag.learningLog.cleared", payload: { ok: true } });
      safeSend(ws, { type: "leadlag.state", payload });
      return;
    }

    if (msg.type === "leadlag.getLearningLog") {
      const payload = paperTest.getState({ includeHistory: false });
      safeSend(ws, { type: "leadlag.learningLog", payload: payload?.learningLog || [] });
      return;
    }

    if (msg.type === "refreshUniverse") {
      safeSend(ws, { type: "universe.refresh.ack", payload: { ok: true } });
      universe.refresh().then(() => broadcast({ type: "universe.status", payload: universe.getStatus() }));
      return;
    }

    if (msg.type === "getPresets") {
      safeSend(ws, { type: "presets.updated", payload: presetsStore.getState() });
      return;
    }

    if (msg.type === "selectPreset") {
      const ok = presetsStore.selectPreset(msg.presetId);
      broadcastEvent("preset.selected", { activePresetId: presetsStore.getState().activePresetId });
      broadcastEvent("presets.updated", presetsStore.getState());
      safeSend(ws, { type: "preset.select.ack", payload: { ok, activePresetId: presetsStore.getState().activePresetId } });
      return;
    }


    if (msg.type === "startRangeTest") {
      const mode = msg.mode === "real" ? "real" : msg.mode === "demo" ? "demo" : "paper";
      tradeExecutor.setExecutionMode(mode);
      if (mode !== "paper" && !tradeExecutor.enabled()) {
        const error = "Demo trade disabled (missing API keys)";
        safeSend(ws, { type: "range.start.ack", payload: { ok: false, error } });
        broadcast({ type: "range.log", payload: { t: Date.now(), level: "error", msg: error } });
        return;
      }
      if (mode === "real" && !TRADE_REAL_ENABLED) {
        const error = "REAL_DISABLED: set TRADE_REAL_ENABLED=1";
        safeSend(ws, { type: "range.start.ack", payload: { ok: false, error } });
        return;
      }
      applyPresetGuardrails(presetsStore.getActivePreset?.());
      safeSend(ws, { type: "range.start.ack", payload: { ok: true, mode } });
      const symbols = universe.getUniverse({ limit: 120 }).symbols || [];
      subscriptions.requestFeed("range", { bybitSymbols: symbols, streams: ["ticker"], needsOi: true });
      rangeTest.start({ mode, preset: msg.preset && typeof msg.preset === "object" ? msg.preset : null });
      return;
    }
    if (msg.type === "stopRangeTest") { safeSend(ws, { type: "range.stop.ack", payload: { ok: true } }); rangeTest.stop({ reason: "manual" }); subscriptions.releaseFeed("range"); return; }
    if (msg.type === "getRangeState") return safeSend(ws, { type: "range.state", payload: rangeTest.getState() });

    if (msg.type === "startImpulseBot") {
      const mode = msg.mode === "real" ? "real" : msg.mode === "demo" ? "demo" : "paper";
      safeSend(ws, { type: "impulse.start.ack", payload: { ok: true, mode } });
      const symbols = universe.getUniverse({ limit: 80 }).symbols || [];
      subscriptions.requestFeed("impulse", { bybitSymbols: symbols, streams: ["ticker"], needsOi: true });
      impulseBot.start({ mode, settings: msg.settings && typeof msg.settings === "object" ? msg.settings : {} });
      return;
    }
    if (msg.type === "stopImpulseBot") { safeSend(ws, { type: "impulse.stop.ack", payload: { ok: true } }); impulseBot.stop({ reason: "manual" }); subscriptions.releaseFeed("impulse"); return; }
    if (msg.type === "impulse.setConfig") {
      const payload = impulseBot.setConfig(msg.settings && typeof msg.settings === 'object' ? msg.settings : {});
      safeSend(ws, { type: "impulse.config.ack", payload: { ok: true } });
      safeSend(ws, { type: "impulse.state", payload });
      return;
    }
    if (msg.type === "getImpulseState") return safeSend(ws, { type: "impulse.state", payload: impulseBot.getState() });
  });

  ws.on("close", () => { stopStatusWatcher(ws); clients.delete(ws); });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`server on http://${HOST}:${PORT}`);

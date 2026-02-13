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
const leadLag = createLeadLag({ bucketMs: 250, maxLagMs: 1000, minSamples: 200, impulseZ: 2.0, minImpulses: 5 });
let lastLeadLagTop = [];
let leadLagSearchActive = false;
function createIdleSearchState() {
  return {
    searchActive: false,
    phase: 'idle',
    message: 'idle',
    startedAt: null,
    symbolsTotal: 0,
    symbolsReady: 0,
    totalPairs: 0,
    processedPairs: 0,
    confirmationsDone: 0,
    confirmationsTarget: 0,
    candidatesKept: 0,
    candidatesCap: 5000,
    screeningTopRows: [],
    topRows: [],
    pct: 0,
    lastUpdateAt: Date.now(),
    error: null,
  };
}
let leadLagSearchState = createIdleSearchState();
let leadLagSearchRunner = null;

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

function getUniverseAllSymbols() {
  return normalizeSymbols(universe.getUniverse({ limit: 2000 }).symbols || [], 2000);
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
    universeList: universe.getUniverse({ limit: 500 }),
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

function broadcastBotsOverview() {
  broadcastEvent("bots.overview", getBotsOverview());
}


function calculateSpreadPct(ticker) {
  const bid = Number(ticker?.bid || 0);
  const ask = Number(ticker?.ask || 0);
  if (!(bid > 0 && ask > 0)) return 0;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : 0;
}

function mapReturns(bars = []) {
  const map = new Map();
  const returns = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = Number(bars[i - 1]?.c || bars[i - 1]?.close);
    const curr = Number(bars[i]?.c || bars[i]?.close);
    const ts = Number(bars[i]?.ts || bars[i]?.t || 0);
    if (!(prev > 0 && curr > 0 && ts > 0)) continue;
    const ret = Math.log(curr / prev);
    map.set(ts, ret);
    returns.push(ret);
  }
  return { map, returns };
}

function stdDev(values = []) {
  if (!values.length) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

function buildSymbolFeature(symbol, bars, impulseZ = 2) {
  const { map, returns } = mapReturns(bars);
  const st = stdDev(returns);
  const threshold = st > 0 ? st * impulseZ : 0.0004;
  const impulseTimes = [];
  for (const [ts, ret] of map.entries()) {
    if (Math.abs(ret) >= threshold) impulseTimes.push(ts);
  }
  return { symbol, returnsMap: map, impulseTimes, st, threshold };
}

function startLeadLagSearch(symbols = getUniverseAllSymbols()) {
  stopLeadLagSearch({ reason: 'restart', preserveRows: false, releaseFeed: true, silent: true });
  const normalized = normalizeSymbols(symbols, 2000).filter((sym) => String(sym).endsWith('USDT'));
  if (!normalized.length) {
    leadLagSearchState = { ...createIdleSearchState(), message: 'universe empty' };
    broadcast({ type: 'leadlag.top', payload: leadLagSearchState });
    return { ok: false, reason: 'UNIVERSE_EMPTY', state: leadLagSearchState };
  }

  subscriptions.requestFeed('leadlag-search', { bybitSymbols: normalized, streams: ['ticker'] });
  const startedAt = Date.now();
  const runner = { active: true, startedAt, lastEmitAt: 0, warmupTimer: null, screenHandle: null, confirmHandle: null };
  leadLagSearchRunner = runner;
  leadLagSearchActive = true;
  lastLeadLagTop = [];
  paperTest.setSearchRows?.([]);
  leadLagSearchState = {
    ...createIdleSearchState(),
    searchActive: true,
    phase: 'warmup',
    message: 'warming up',
    startedAt,
    symbolsTotal: normalized.length,
  };

  const throttledBroadcast = (force = false) => {
    leadLagSearchState.lastUpdateAt = Date.now();
    if (!force && Date.now() - Number(runner.lastEmitAt || 0) < 250) return;
    runner.lastEmitAt = Date.now();
    broadcast({ type: 'leadlag.top', payload: leadLagSearchState });
  };

  const updateState = (patch = {}, force = false) => {
    const next = { ...leadLagSearchState, ...patch };
    next.processedPairs = Math.min(Number(next.processedPairs || 0), Number(next.totalPairs || 0));
    next.confirmationsDone = Math.min(Number(next.confirmationsDone || 0), Number(next.confirmationsTarget || 0));
    const warmupPct = next.symbolsTotal > 0 ? (next.symbolsReady / next.symbolsTotal) : 0;
    const screeningPct = next.totalPairs > 0 ? (next.processedPairs / next.totalPairs) : 0;
    const confirmationsPct = next.confirmationsTarget > 0 ? (next.confirmationsDone / next.confirmationsTarget) : (next.phase === 'finished' ? 1 : 0);
    if (next.phase === 'warmup') next.pct = Math.max(0, Math.min(1, warmupPct * 0.2));
    else if (next.phase === 'screening') next.pct = Math.max(0.2, Math.min(0.8, 0.2 + screeningPct * 0.6));
    else if (next.phase === 'confirmations') next.pct = Math.max(0.8, Math.min(1, 0.8 + confirmationsPct * 0.2));
    else if (next.phase === 'finished') next.pct = 1;
    else if (next.phase === 'idle') next.pct = 0;
    leadLagSearchState = next;
    throttledBroadcast(force);
  };

  const finishSearch = ({ message = 'finished', topRows = leadLagSearchState.topRows || [] } = {}) => {
    if (!runner.active) return;
    runner.active = false;
    leadLagSearchActive = false;
    const finalRows = (topRows || []).slice(0, 50);
    lastLeadLagTop = finalRows;
    paperTest.setSearchRows?.(finalRows);
    updateState({
      searchActive: false,
      phase: 'finished',
      message,
      topRows: finalRows,
      screeningTopRows: finalRows,
      confirmationsDone: Number(leadLagSearchState.confirmationsTarget || 0),
    }, true);
    subscriptions.releaseFeed('leadlag-search');
  };

  const failSearch = (errorMessage) => {
    if (!runner.active) return;
    runner.active = false;
    leadLagSearchActive = false;
    updateState({ searchActive: false, phase: 'finished', message: errorMessage, error: errorMessage }, true);
    subscriptions.releaseFeed('leadlag-search');
  };

  throttledBroadcast(true);

  const warmupStartedAt = Date.now();
  const warmupMaxMs = 20_000;
  const minBars = 60;

  const warmupTick = () => {
    if (!runner.active) return;
    const ready = [];
    for (const sym of normalized) {
      if (!runner.active) return;
      const t = marketData.getTicker(sym, 'BT');
      if (!t || (Date.now() - Number(t.ts || 0)) > 15_000) continue;
      if ((marketBars.getBars(sym, 200, 'BT') || []).length >= minBars) ready.push(sym);
    }
    updateState({ symbolsReady: ready.length, message: ready.length < normalized.length ? 'warming up' : 'warmup done' });

    if (!runner.active) return;
    if ((Date.now() - warmupStartedAt) < warmupMaxMs && ready.length < normalized.length) {
      runner.warmupTimer = setTimeout(warmupTick, 500);
      return;
    }
    if (ready.length < 30) {
      failSearch('Not enough symbols ready for search');
      return;
    }
    runScreening(ready);
  };

  const runScreening = (readySymbols) => {
    if (!runner.active) return;
    const minConfirm = 2;
    const minImpulses = 5;
    const lagOptions = [250, 500, 750, 1000];
    const leaderMoveThr = Math.max(0.0005, Number(paperTest.getState({ includeHistory: false })?.settings?.leaderMovePct || 0.1) / 100);
    const candidateCap = 5000;
    const previewCap = 50;

    const features = new Map();
    for (const sym of readySymbols) {
      if (!runner.active) return;
      features.set(sym, buildSymbolFeature(sym, marketBars.getBars(sym, 500, 'BT') || []));
    }

    let i = 0;
    let j = 0;
    let processedPairs = 0;
    const totalPairs = readySymbols.length * Math.max(0, readySymbols.length - 1);
    const candidates = [];
    const screeningTopRows = [];

    const tryKeep = (arr, row, cap, scoreKey = 'confirmations') => {
      if (arr.length < cap) {
        arr.push(row);
        return;
      }
      arr.sort((a, b) => Number(a[scoreKey] || 0) - Number(b[scoreKey] || 0));
      if (Number(row[scoreKey] || 0) > Number(arr[0]?.[scoreKey] || 0)) arr[0] = row;
    };

    const scorePair = (leader, follower) => {
      if (!runner.active || leader === follower) return null;
      const lt = marketData.getTicker(leader, 'BT');
      const ft = marketData.getTicker(follower, 'BT');
      if (!lt || !ft) return null;
      if ((Date.now() - Number(lt.ts || 0)) > 15_000 || (Date.now() - Number(ft.ts || 0)) > 15_000) return null;
      if (calculateSpreadPct(lt) > 0.12 || calculateSpreadPct(ft) > 0.12) return null;
      const lf = features.get(leader);
      const ff = features.get(follower);
      if (!lf || !ff) return null;
      if (lf.returnsMap.size < minBars || ff.returnsMap.size < minBars) return null;
      if ((lf.impulseTimes?.length || 0) < minImpulses) return null;

      let bestLag = 250;
      let bestConf = 0;
      for (const lag of lagOptions) {
        if (!runner.active) return null;
        let conf = 0;
        for (const ts of lf.impulseTimes) {
          if (!runner.active) return null;
          const leaderRet = lf.returnsMap.get(ts);
          const followerRet = ff.returnsMap.get(ts + lag);
          if (!Number.isFinite(leaderRet) || !Number.isFinite(followerRet)) continue;
          if (Math.abs(leaderRet) < leaderMoveThr || Math.abs(followerRet) < leaderMoveThr) continue;
          if (Math.sign(leaderRet) !== Math.sign(followerRet)) continue;
          conf += 1;
        }
        if (conf > bestConf) {
          bestConf = conf;
          bestLag = lag;
        }
      }
      if (bestConf < minConfirm) return null;
      return { leader, follower, lagMs: bestLag, confirmations: bestConf, corr: null, impulses: lf.impulseTimes.length, source: 'BT' };
    };

    updateState({ phase: 'screening', message: 'screening', totalPairs, processedPairs: 0, candidatesKept: 0, topRows: [], screeningTopRows: [] }, true);

    const screeningTick = () => {
      if (!runner.active) return;
      const tickStart = performance.now();
      while ((performance.now() - tickStart) < 12 && i < readySymbols.length) {
        const leader = readySymbols[i];
        const follower = readySymbols[j];
        j += 1;
        if (j >= readySymbols.length) { i += 1; j = 0; }
        if (!leader || !follower || leader === follower) continue;
        processedPairs += 1;
        const scored = scorePair(leader, follower);
        if (!scored) continue;
        tryKeep(candidates, scored, candidateCap);
        tryKeep(screeningTopRows, scored, previewCap);
      }

      const sortedPreview = [...screeningTopRows].sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0)).slice(0, 50);
      updateState({ processedPairs, candidatesKept: candidates.length, screeningTopRows: sortedPreview, topRows: sortedPreview });

      if (i >= readySymbols.length) {
        runConfirmations([...candidates].sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0)).slice(0, 1500), features);
        return;
      }
      runner.screenHandle = setImmediate(screeningTick);
    };

    runner.screenHandle = setImmediate(screeningTick);
  };

  const runConfirmations = (candidates, features) => {
    if (!runner.active) return;
    if (!candidates.length) {
      finishSearch({ message: 'finished: no candidates', topRows: [] });
      return;
    }

    const reducedSymbols = [...new Set(candidates.flatMap((row) => [row.leader, row.follower]))];
    subscriptions.releaseFeed('leadlag-search');
    subscriptions.requestFeed('leadlag-search', { bybitSymbols: reducedSymbols, streams: ['ticker'] });

    let idx = 0;
    const rows = [];
    const total = candidates.length;
    updateState({ phase: 'confirmations', message: 'confirmations', confirmationsDone: 0, confirmationsTarget: total }, true);

    const corrForPair = (leaderMap, followerMap, lagMs) => {
      const xs = [];
      const ys = [];
      for (const [ts, lret] of leaderMap.entries()) {
        if (!runner.active) return null;
        const fret = followerMap.get(ts + lagMs);
        if (!Number.isFinite(fret)) continue;
        xs.push(lret);
        ys.push(fret);
        if (xs.length >= 480) break;
      }
      const n = xs.length;
      if (n < 120) return null;
      const avgX = xs.reduce((a, b) => a + b, 0) / n;
      const avgY = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0; let dx = 0; let dy = 0;
      for (let k = 0; k < n; k += 1) {
        const vx = xs[k] - avgX;
        const vy = ys[k] - avgY;
        num += vx * vy;
        dx += vx * vx;
        dy += vy * vy;
      }
      const epsilon = 1e-9;
      if (dx <= epsilon || dy <= epsilon) return null;
      const den = Math.sqrt(dx * dy);
      return den > epsilon ? (num / den) : null;
    };

    const confTick = () => {
      if (!runner.active) return;
      const tickStart = performance.now();
      while ((performance.now() - tickStart) < 12 && idx < candidates.length) {
        const row = candidates[idx];
        idx += 1;
        const lf = features.get(row.leader);
        const ff = features.get(row.follower);
        if (!lf || !ff) continue;
        const corr = corrForPair(lf.returnsMap, ff.returnsMap, Number(row.lagMs || 250));
        const activePreset = presetsStore.getActivePreset();
        const readiness = evaluateTradeReady({ row: { ...row, corr: Number(corr || 0) }, preset: activePreset, excludedCoins: Array.isArray(activePreset?.excludedCoins) ? activePreset.excludedCoins : [], lastTradeAt: paperTest.getState({ includeHistory: false })?.position?.openedAt || 0, getBars: (sym, n, source) => marketBars.getBars(sym, n, source), bucketMs: 250 });
        rows.push({ ...row, corr, tradeReady: readiness.tradeReady, blockers: readiness.blockers, source: 'BT' });
      }

      rows.sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0) || Math.abs(Number(b.corr || 0)) - Math.abs(Number(a.corr || 0)) || Number(a.lagMs || 0) - Number(b.lagMs || 0));
      updateState({ confirmationsDone: idx, topRows: rows.slice(0, 50) });

      if (idx >= total) {
        finishSearch({ message: 'finished', topRows: rows.slice(0, 50) });
        return;
      }
      runner.confirmHandle = setImmediate(confTick);
    };

    runner.confirmHandle = setImmediate(confTick);
  };

  runner.warmupTimer = setTimeout(warmupTick, 0);
  return { ok: true, active: true, state: leadLagSearchState };
}

function stopLeadLagSearch({ reason = 'stopped', preserveRows = false, releaseFeed = true, silent = false } = {}) {
  const runner = leadLagSearchRunner;
  if (runner) {
    runner.active = false;
    if (runner.warmupTimer) clearTimeout(runner.warmupTimer);
    if (runner.screenHandle) clearImmediate(runner.screenHandle);
    if (runner.confirmHandle) clearImmediate(runner.confirmHandle);
  }
  leadLagSearchRunner = null;
  leadLagSearchActive = false;
  if (releaseFeed) subscriptions.releaseFeed('leadlag-search');
  leadLagSearchState = preserveRows
    ? { ...leadLagSearchState, searchActive: false, phase: 'finished', message: reason, pct: 1, lastUpdateAt: Date.now() }
    : { ...createIdleSearchState(), message: reason };
  if (!silent) broadcast({ type: 'leadlag.top', payload: leadLagSearchState });
  return leadLagSearchState;
}

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

app.get("/health", async () => {
  const bybitWs = getBybitHealth();
  const cmc = await getCmcHealth();
  const universeStatus = universe.getStatus();
  const failedChecks = [cmc, bybitWs].filter((c) => String(c?.status || "").toLowerCase() === "error");

  return {
    status: failedChecks.length ? "degraded" : "ok",
    now: Date.now(),
    uptimeMs: Math.floor(process.uptime() * 1000),
    checks: {
      bybitWs,
      cmc,
      universe: universeStatus,
    },
  };
});
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
app.get("/api/universe/list", async () => {
  const u = universe.getUniverse({ limit: 2000 }) || {};
  return { symbols: u.symbols || [], updatedAt: u.updatedAt || null };
});
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

async function getCmcHealth() {
  const apiKey = process.env.CMC_API_KEY || process.env.COINMARKETCAP_API_KEY || "";
  if (!apiKey) {
    return {
      status: "disabled",
      reason: "missing_api_key",
    };
  }

  const startedAt = Date.now();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 8000);

  try {
    const res = await fetch("https://pro-api.coinmarketcap.com/v1/key/info", {
      headers: { "X-CMC_PRO_API_KEY": apiKey },
      signal: ac.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!res.ok) {
      return {
        status: "error",
        httpStatus: res.status,
        latencyMs: Date.now() - startedAt,
        error: data?.status?.error_message || `HTTP ${res.status}`,
      };
    }

    return {
      status: "ok",
      latencyMs: Date.now() - startedAt,
      plan: data?.data?.plan?.name || null,
      usageResetAt: data?.data?.plan?.credit_limit_reset_at || null,
    };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - startedAt,
      error: String(err?.message || err),
    };
  } finally {
    clearTimeout(timeout);
  }
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
  const st = { id, lastSeenAt: Date.now(), rttMs: null, lastPongAt: null, timer: null, cmcCache: { status: 'waiting', lastCheckAt: null, ageMs: null, latencyMs: null } };
  st.timer = setInterval(async () => {
    const cmc = await getCmcHealth();
    const lastCheckAt = Date.now();
    st.cmcCache = {
      status: cmc?.status || 'error',
      lastCheckAt,
      ageMs: 0,
      latencyMs: Number(cmc?.latencyMs || 0) || null,
      error: cmc?.error ? String(cmc.error).slice(0, 200) : undefined,
    };
    sendEvent(ws, 'status.health', {
      now: Date.now(),
      ws: { connected: true, lastSeenAt: st.lastSeenAt, rttMs: st.rttMs },
      bybitWs: getBybitHealth(),
      cmcApi: { ...st.cmcCache, ageMs: Math.max(0, Date.now() - Number(st.cmcCache.lastCheckAt || Date.now())) },
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
      const active = Boolean(msg?.active ?? msg?.payload?.active);
      if (active) startStatusWatcher(ws);
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
      safeSend(ws, { type: "leadlag.top", payload: { ...leadLagSearchState, topRows: (leadLagSearchState.topRows || lastLeadLagTop).slice(0, n) } });
      return;
    }

    if (msg.type === "startPaperTest" || msg.type === "startLeadLag") {
      const presetId = msg.presetId || presetsStore.getState().activePresetId;
      const settings = msg?.settings && typeof msg.settings === "object" ? msg.settings : null;
      applyPresetGuardrails(presetsStore.getPresetById?.(presetId) || presetsStore.getActivePreset?.());
      const leader = String(settings?.leaderSymbol || "BTCUSDT").toUpperCase();
      const follower = String(settings?.followerSymbol || "ETHUSDT").toUpperCase();
      subscriptions.requestFeed("leadlag-trading", { bybitSymbols: [leader, follower], streams: ["ticker"] });
      stopLeadLagSearch({ reason: 'stopped: trading started', preserveRows: false, releaseFeed: true });
      const result = paperTest.start({ presetId, mode: msg.mode || "paper", settings });
      const currentState = paperTest.getState();
      broadcast({ type: 'leadlag.state', payload: currentState });
      broadcastBotsOverview();
      safeSend(ws, { type: "leadlag.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      safeSend(ws, { type: "paper.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      return;
    }

    if (msg.type === "stopPaperTest" || msg.type === "stopLeadLag") {
      paperTest.stop({ reason: "manual" });
      subscriptions.releaseFeed("leadlag-trading");
      const currentState = paperTest.getState();
      broadcast({ type: 'leadlag.state', payload: currentState });
      broadcastBotsOverview();
      safeSend(ws, { type: "leadlag.stop.ack", payload: { ok: true, state: currentState } });
      safeSend(ws, { type: "paper.stop.ack", payload: { ok: true, state: currentState } });
      return;
    }


    if (msg.type === "startLeadLagSearch") {
      const symbols = getUniverseAllSymbols();
      const result = startLeadLagSearch(symbols);
      safeSend(ws, { type: "leadlag.search.ack", payload: { ok: Boolean(result?.ok), active: Boolean(result?.active), reason: result?.reason || null, state: result?.state || leadLagSearchState } });
      return;
    }
    if (msg.type === "stopLeadLagSearch") {
      const stoppedState = stopLeadLagSearch({ reason: 'stopped', preserveRows: false, releaseFeed: true });
      safeSend(ws, { type: "leadlag.search.ack", payload: { ok: true, active: false, state: stoppedState } });
      return;
    }

    if (msg.type === "resetLeadLag") {
      paperTest.stop({ reason: "reset" });
      subscriptions.releaseFeed("leadlag-trading");
      subscriptions.releaseFeed("leadlag-search");
      stopLeadLagSearch({ reason: 'stopped: reset', preserveRows: false, releaseFeed: true });
      const payload = paperTest.reset();
      const currentState = paperTest.getState();
      broadcast({ type: 'leadlag.state', payload: currentState });
      broadcastBotsOverview();
      safeSend(ws, { type: "leadlag.reset.ack", payload: { ...(payload || {}), state: currentState, searchState: leadLagSearchState } });
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

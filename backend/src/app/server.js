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
import { createBybitPrivateRest } from "../bybitPrivateRest.js";
import { createBybitInstrumentsCache } from "../bybitInstrumentsCache.js";
import { createBybitTradeExecutor } from "../bybitTradeExecutor.js";
import { createMarketDataStore } from "../marketDataStore.js";
import { createPresetsStore } from "../presetsStore.js";
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

function isHighBackpressure(ws) {
  return Number(ws?.bufferedAmount || 0) > LEADLAG_EMIT_LIMITS.wsBufferedAmountLimit;
}

function sendLeadLagEventNow(ws, topic, payload) {
  safeSend(ws, { type: 'event', topic, payload });
  safeSend(ws, { type: topic, payload });
}

const leadLagEmitState = {
  leadlagState: { payload: null, timer: null, lastAt: 0 },
  leadlagSearchProgress: { payload: null, timer: null, lastAt: 0 },
  leadlagSearchResults: { payload: null, timer: null, lastAt: 0 },
};

function broadcastLeadLagManaged({ topic, payload, bucket = 'leadlagState', intervalMs = 250, force = false } = {}) {
  if (force) {
    for (const ws of clients) sendLeadLagEventNow(ws, topic, payload);
    return;
  }
  const st = leadLagEmitState[bucket];
  if (!st) {
    for (const ws of clients) {
      if (isHighBackpressure(ws)) continue;
      sendLeadLagEventNow(ws, topic, payload);
    }
    return;
  }
  st.payload = payload;
  const flush = () => {
    st.timer = null;
    const out = st.payload;
    if (!out) return;
    st.payload = null;
    st.lastAt = Date.now();
    for (const ws of clients) {
      if (isHighBackpressure(ws)) continue;
      sendLeadLagEventNow(ws, topic, out);
    }
  };
  const due = Math.max(0, intervalMs - (Date.now() - Number(st.lastAt || 0)));
  if (due <= 0) flush();
  else if (!st.timer) st.timer = setTimeout(flush, due);
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
const LEADLAG_EMIT_LIMITS = {
  stateMs: 250,
  searchProgressMs: 500,
  searchResultsMs: 1000,
  wsBufferedAmountLimit: Number(process.env.WS_BUFFERED_AMOUNT_LIMIT || (1024 * 1024 * 2)),
};
let leadLagSnapshotSeq = 0;

function createIdleSearchState() {
  return {
    searchActive: false,
    status: 'IDLE',
    jobId: null,
    phase: 'IDLE',
    message: 'idle',
    startedAt: null,
    updatedAtMs: Date.now(),
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
    reducedSymbols: 0,
    subscribedSymbols: 0,
    progress: { phase: 'IDLE', done: 0, total: 0, pct: 0, message: 'idle', lastTickMs: Date.now() },
    params: { universeSize: 300, topK: 50, warmupSec: 15, timeBudgetMs: 8, maxPairsPerTick: 2000, lagsMs: [-1000, -750, -500, -250, 250, 500, 750, 1000], confirmWindowSec: 120 },
    load: { subscribedSymbols: 0, reducedSymbols: 0, cpuMsPerSec: 0, backlog: 0 },
    results: { updatedAtMs: Date.now(), top: [] },
    error: null,
    lastUpdateAt: Date.now(),
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
  onLiquidation: () => {},
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
    if (type === 'leadlag.state') {
      emitLeadLagState({ force: false, bumpSeq: true });
    } else if (type === 'leadlag.log') {
      broadcastLeadLagManaged({ topic: 'leadlag.log', payload, bucket: null, force: false });
    } else if (type === 'leadlag.trade' || type === 'paper.trade') {
      broadcastLeadLagManaged({ topic: 'leadlag.tradeEvent', payload, bucket: null, force: true });
    } else {
      broadcast({ type, payload });
    }
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


function mapTradingStatus(status) {
  const normalized = String(status || 'STOPPED').toUpperCase();
  if (normalized === 'STOPPING') return 'STOPPED';
  if (normalized === 'RUNNING' || normalized === 'STARTING' || normalized === 'STOPPED') return normalized;
  return 'STOPPED';
}

function toLeadLagStateSnapshot({ bumpSeq = true } = {}) {
  const trading = paperTest.getState({ includeHistory: true }) || {};
  const search = leadLagSearchState || createIdleSearchState();
  if (bumpSeq) leadLagSnapshotSeq += 1;

  const leader = String(trading?.settings?.leaderSymbol || trading?.manual?.leaderSymbol || 'BTCUSDT').toUpperCase();
  const follower = String(trading?.settings?.followerSymbol || trading?.manual?.followerSymbol || 'ETHUSDT').toUpperCase();
  const leaderTicker = marketData.getTicker(leader, 'BT') || {};
  const followerTicker = marketData.getTicker(follower, 'BT') || {};
  const topRows = Array.isArray(search?.results?.top) ? search.results.top : Array.isArray(search?.topRows) ? search.topRows : [];

  const payload = {
    schemaVersion: 1,
    snapshotSeq: leadLagSnapshotSeq,
    serverTimeMs: Date.now(),
    trading: {
      status: mapTradingStatus(trading?.status),
      runId: trading?.currentRunKey || null,
      startedAtMs: Number(trading?.startedAt || 0) || null,
      stoppedAtMs: Number(trading?.endedAt || 0) || null,
      pair: { leader, follower },
      params: {
        triggerPct: Number(trading?.settings?.leaderMovePct ?? 0.1),
        tpPct: Number(trading?.settings?.followerTpPct ?? 0.1),
        slPct: Number(trading?.settings?.followerSlPct ?? 0.1),
        maxConcurrent: 5,
        hedgeAllowed: Boolean(trading?.settings?.allowShort ?? true),
        priceBasis: 'MARK',
      },
      baseline: {
        leader0: Number(trading?.manual?.leaderBaseline || 0) || null,
        follower0: null,
      },
      prices: {
        leader: { mark: Number(leaderTicker?.mark || 0) || null, last: Number(leaderTicker?.last || 0) || null, tsMs: Number(leaderTicker?.ts || 0) || null },
        follower: { mark: Number(followerTicker?.mark || 0) || null, last: Number(followerTicker?.last || 0) || null, tsMs: Number(followerTicker?.ts || 0) || null },
      },
      telemetry: {
        leaderMovePct: Number(trading?.manual?.leaderMovePctNow || 0) || 0,
        followerMovePct: 0,
        lastUpdateMs: Date.now(),
        lastEventAgeMs: Number.isFinite(Number(trading?.currentTradeEvents?.[0]?.ts || 0)) ? Math.max(0, Date.now() - Number(trading.currentTradeEvents[0].ts)) : null,
      },
      positions: (Array.isArray(trading?.positions) ? trading.positions : []).slice(0, 5).map((p) => ({
        posId: p?.id || p?.posId || `${p?.side || 'POS'}:${p?.openedAt || Date.now()}`,
        side: p?.side || null,
        qty: Number(p?.qty || 0) || 0,
        entryPx: Number(p?.entry || p?.entryPrice || 0) || null,
        entryTs: Number(p?.openedAt || 0) || null,
        status: 'OPEN',
        unrealizedPnl: Number(p?.unrealizedPnl || 0) || 0,
        realizedPnl: Number(p?.realizedPnl || 0) || 0,
        fees: Number(p?.fees || 0) || 0,
        funding: Number(p?.funding || 0) || 0,
        slippage: Number(p?.slippage || 0) || 0,
      })),
      tradeEvents: (Array.isArray(trading?.currentTradeEvents) ? trading.currentTradeEvents : []).slice(0, 20),
      history: Array.isArray(trading?.currentClosedTrades) ? trading.currentClosedTrades : [],
      stats: {
        line1: {
          trades: Number(trading?.stats?.trades || 0), wins: Number(trading?.stats?.wins || 0), losses: Number(trading?.stats?.losses || 0),
          winratePct: Number(trading?.stats?.winRate || 0), pnl: Number(trading?.stats?.pnlUSDT || 0),
        },
        line2: {
          fees: Number(trading?.stats?.feesUSDT || 0), funding: Number(trading?.stats?.fundingUSDT || 0), slippage: Number(trading?.stats?.slippageUSDT || 0), feeRateBps: Number(trading?.stats?.feeRateMaker || 0) * 10000,
        },
      },
    },
    search: {
      status: search?.status || 'IDLE',
      jobId: search?.jobId || null,
      startedAtMs: Number(search?.startedAt || 0) || null,
      updatedAtMs: Number(search?.updatedAtMs || Date.now()),
      params: search?.params || createIdleSearchState().params,
      progress: search?.progress || { phase: 'IDLE', done: 0, total: 0, pct: 0, message: 'idle', lastTickMs: Date.now() },
      load: search?.load || { subscribedSymbols: 0, reducedSymbols: 0, cpuMsPerSec: 0, backlog: 0 },
      results: {
        updatedAtMs: Number(search?.results?.updatedAtMs || Date.now()),
        top: topRows.slice(0, 50).map((r) => ({
          leader: r?.leader, follower: r?.follower, score: Number(r?.score || r?.confirmations || 0), corr: Number(r?.corr || 0), lagMs: Number(r?.lagMs || 0),
          confirmations: Number(r?.confirmations || 0), impulses: Number(r?.impulses || 0), samples: Number(r?.samples || 0), lastSeenAgeMs: Number(r?.lastSeenAgeMs || 0),
        })),
      },
      error: search?.error || null,
    },
    legacy: trading,
  };
  return payload;
}

function emitLeadLagState({ force = false, bumpSeq = true } = {}) {
  const snapshot = toLeadLagStateSnapshot({ bumpSeq });
  broadcastLeadLagManaged({ topic: 'leadlag.state', payload: snapshot, bucket: 'leadlagState', intervalMs: LEADLAG_EMIT_LIMITS.stateMs, force });
  return snapshot;
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
    leadlagState: toLeadLagStateSnapshot({ bumpSeq: false }),
    universeStatus: universe.getStatus(),
    universeList: universe.getUniverse({ limit: 500 }),
    botsOverview: getBotsOverview(),
    watchlists: {
      leadlag: bybit.getSymbols().slice(0, 100),
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
  const paperBalance = Number(process.env.PAPER_WALLET_BALANCE || 10000);
  const agg = journalStore.getAggregates();
  return {
    ts: Date.now(),
    paperBalance,
    bots: [
      { name: "LeadLag", status: leadlagState.status || "STOPPED", pnl: Number(agg?.LeadLag?.pnlUsdt ?? toBotPnl(leadlagState)), startedAt: leadlagState.startedAt || null },
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


function startLeadLagSearch(symbols = getUniverseAllSymbols(), inputParams = {}) {
  stopLeadLagSearch({ reason: 'restart', preserveRows: false, releaseFeed: true, silent: true });
  const normalized = normalizeSymbols(symbols, 2000).filter((sym) => String(sym).endsWith('USDT'));
  const params = {
    ...createIdleSearchState().params,
    ...((inputParams && typeof inputParams === 'object') ? inputParams : {}),
  };
  if (!normalized.length) {
    leadLagSearchState = { ...createIdleSearchState(), message: 'universe empty', status: 'ERROR', phase: 'ERROR', error: { code: 'UNIVERSE_EMPTY', message: 'universe empty' } };
    emitLeadLagState({ force: true, bumpSeq: true });
    return { ok: false, reason: 'UNIVERSE_EMPTY', state: leadLagSearchState };
  }

  subscriptions.replaceIntent('leadlag-search', { symbols: normalized, streamType: 'ticker' });
  const startedAt = Date.now();
  const runner = { active: true, startedAt, jobId: `${startedAt}-${Math.random().toString(36).slice(2, 8)}`, warmupTimer: null, handle: null, cancel: false, cpuMs: 0 };
  leadLagSearchRunner = runner;
  leadLagSearchActive = true;
  lastLeadLagTop = [];
  paperTest.setSearchRows?.([]);

  const pushProgress = (force = false) => {
    const topRows = Array.isArray(leadLagSearchState?.topRows) ? leadLagSearchState.topRows : [];
    broadcastLeadLagManaged({ topic: 'leadlag.searchProgress', payload: leadLagSearchState.progress, bucket: 'leadlagSearchProgress', intervalMs: LEADLAG_EMIT_LIMITS.searchProgressMs, force });
    broadcastLeadLagManaged({ topic: 'leadlag.searchResults', payload: { updatedAtMs: Date.now(), top: topRows.slice(0, 50) }, bucket: 'leadlagSearchResults', intervalMs: LEADLAG_EMIT_LIMITS.searchResultsMs, force });
    emitLeadLagState({ force, bumpSeq: true });
  };

  const updateState = (patch = {}, force = false) => {
    const next = { ...leadLagSearchState, ...patch };
    next.updatedAtMs = Date.now();
    next.lastUpdateAt = Date.now();
    next.progress = { ...(next.progress || {}), ...(patch.progress || {}) };
    next.progress.phase = String(next.phase || next.status || 'IDLE').toUpperCase();
    if (!Number.isFinite(Number(next.progress.total))) next.progress.total = 0;
    if (!Number.isFinite(Number(next.progress.done))) next.progress.done = 0;
    if (!['IDLE', 'FINISHED', 'ERROR'].includes(String(next.status || 'IDLE').toUpperCase()) && Number(next.progress.total) <= 0) {
      next.progress.total = Math.max(1, Number(next.symbolsTotal || 0));
    }
    next.progress.pct = next.progress.total > 0 ? Math.max(0, Math.min(100, (Number(next.progress.done || 0) / Number(next.progress.total || 1)) * 100)) : 0;
    next.progress.lastTickMs = Date.now();
    next.load = {
      ...(next.load || {}),
      subscribedSymbols: Number(next.subscribedSymbols || next.symbolsTotal || 0),
      reducedSymbols: Number(next.reducedSymbols || 0),
      cpuMsPerSec: Number(runner.cpuMs || 0),
      backlog: Number(next.progress.total || 0) - Number(next.progress.done || 0),
    };
    next.results = { updatedAtMs: Date.now(), top: (next.topRows || []).slice(0, 50) };
    leadLagSearchState = next;
    pushProgress(force);
  };

  const finish = ({ status = 'FINISHED', message = 'finished', error = null } = {}) => {
    if (!runner.active) return;
    runner.active = false;
    leadLagSearchRunner = null;
    leadLagSearchActive = false;
    subscriptions.removeIntent('leadlag-search');
    updateState({
      searchActive: false,
      status,
      phase: status,
      message,
      error,
      progress: {
        done: Number(leadLagSearchState.progress?.total || leadLagSearchState.progress?.done || 0),
        total: Number(leadLagSearchState.progress?.total || 0),
        message,
      },
    }, true);
  };

  leadLagSearchState = {
    ...createIdleSearchState(),
    ...leadLagSearchState,
    searchActive: true,
    status: 'WARMUP',
    phase: 'WARMUP',
    jobId: runner.jobId,
    message: 'warming up',
    startedAt,
    updatedAtMs: startedAt,
    symbolsTotal: normalized.length,
    subscribedSymbols: normalized.length,
    params,
    progress: { phase: 'WARMUP', done: 0, total: Math.max(1, normalized.length), pct: 0, message: 'warming up', lastTickMs: startedAt },
  };
  pushProgress(true);

  const warmupStartedAt = Date.now();
  const warmupMaxMs = Math.max(1, Number(params.warmupSec || 15) * 1000);
  const minBars = 60;

  const runConfirmations = (candidates, features) => {
    if (!runner.active) return;
    if (!candidates.length) {
      finish({ status: 'FINISHED', message: 'finished: no candidates' });
      return;
    }

    const reducedSymbols = [...new Set(candidates.flatMap((row) => [row.leader, row.follower]))].slice(0, 100);
    subscriptions.replaceIntent('leadlag-search', { symbols: reducedSymbols, streamType: 'ticker' });
    updateState({ status: 'CONFIRMATIONS', phase: 'CONFIRMATIONS', message: 'confirmations', reducedSymbols: reducedSymbols.length, subscribedSymbols: reducedSymbols.length, progress: { done: 0, total: candidates.length, message: 'confirmations' } }, true);

    let idx = 0;
    const rows = [];
    const total = candidates.length;

    const confTick = () => {
      if (!runner.active) return;
      const tickStart = performance.now();
      const budget = Math.max(1, Number(params.timeBudgetMs || 8));
      const maxPerTick = Math.max(1, Number(params.maxPairsPerTick || 2000));
      let local = 0;
      while ((performance.now() - tickStart) < budget && idx < total && local < maxPerTick) {
        local += 1;
        const row = candidates[idx++];
        const lf = features.get(row.leader);
        const ff = features.get(row.follower);
        if (!lf || !ff) continue;
        rows.push({ ...row, corr: Number(row.corr || 0), source: 'BT', lastSeenAgeMs: 0, tradeReady: Boolean(row.tradeReady) });
      }
      runner.cpuMs = Math.round((runner.cpuMs * 0.7) + ((performance.now() - tickStart) * 0.3));
      rows.sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0) || Math.abs(Number(b.corr || 0)) - Math.abs(Number(a.corr || 0)));
      const topRows = rows.slice(0, Math.max(50, Number(params.topK || 50)));
      lastLeadLagTop = topRows.slice(0, 50);
      paperTest.setSearchRows?.(lastLeadLagTop);
      updateState({ topRows: lastLeadLagTop, progress: { done: idx, total, message: 'confirmations' } });
      if (idx >= total) {
        finish({ status: 'FINISHED', message: 'finished' });
        return;
      }
      runner.handle = setImmediate(confTick);
    };

    runner.handle = setImmediate(confTick);
  };

  const runScreening = (readySymbols) => {
    if (!runner.active) return;
    const lags = Array.isArray(params.lagsMs) && params.lagsMs.length ? params.lagsMs : [250, 500, 750, 1000];
    const leaderMoveThr = Math.max(0.0005, Number(paperTest.getState({ includeHistory: false })?.settings?.leaderMovePct || 0.1) / 100);
    const candidateCap = 5000;
    const features = new Map();
    for (const sym of readySymbols) features.set(sym, buildSymbolFeature(sym, marketBars.getBars(sym, 500, 'BT') || []));

    const pairs = [];
    for (let i = 0; i < readySymbols.length; i += 1) {
      for (let j = 0; j < readySymbols.length; j += 1) {
        if (i !== j) pairs.push([readySymbols[i], readySymbols[j]]);
      }
    }
    const totalPairs = pairs.length;
    updateState({ status: 'SCREENING', phase: 'SCREENING', message: 'screening', totalPairs, progress: { done: 0, total: Math.max(1, totalPairs), message: 'screening' } }, true);

    let idx = 0;
    const candidates = [];
    const scorePair = (leader, follower) => {
      const lf = features.get(leader);
      const ff = features.get(follower);
      if (!lf || !ff) return null;
      let best = null;
      for (const lag of lags) {
        let conf = 0;
        for (const ts of ff.impulseTimes) {
          const x = lf.returnsMap.get(ts - lag);
          const y = ff.returnsMap.get(ts);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (Math.abs(x) < leaderMoveThr || Math.abs(y) < leaderMoveThr) continue;
          if (Math.sign(x) !== Math.sign(y)) continue;
          conf += 1;
        }
        if (!best || conf > best.confirmations) best = { leader, follower, lagMs: lag, confirmations: conf, impulses: ff.impulseTimes.length, score: conf };
      }
      return best && best.confirmations > 1 ? best : null;
    };

    const screeningTick = () => {
      if (!runner.active) return;
      const tickStart = performance.now();
      const budget = Math.max(1, Number(params.timeBudgetMs || 8));
      const maxPerTick = Math.max(1, Number(params.maxPairsPerTick || 2000));
      let local = 0;
      while ((performance.now() - tickStart) < budget && idx < pairs.length && local < maxPerTick) {
        local += 1;
        const [leader, follower] = pairs[idx++];
        const scored = scorePair(leader, follower);
        if (scored) {
          candidates.push(scored);
          candidates.sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0));
          if (candidates.length > candidateCap) candidates.length = candidateCap;
        }
      }
      runner.cpuMs = Math.round((runner.cpuMs * 0.7) + ((performance.now() - tickStart) * 0.3));
      const topRows = candidates.slice(0, 50);
      updateState({ topRows, candidatesKept: candidates.length, processedPairs: idx, progress: { done: idx, total: Math.max(1, totalPairs), message: 'screening' } });
      if (idx >= pairs.length) {
        runConfirmations(candidates.slice(0, 1500), features);
        return;
      }
      runner.handle = setImmediate(screeningTick);
    };

    runner.handle = setImmediate(screeningTick);
  };

  const warmupTick = () => {
    if (!runner.active) return;
    const ready = [];
    for (const sym of normalized) {
      const t = marketData.getTicker(sym, 'BT');
      if (!t || (Date.now() - Number(t.ts || 0)) > 15_000) continue;
      if ((marketBars.getBars(sym, 200, 'BT') || []).length >= minBars) ready.push(sym);
    }
    updateState({ symbolsReady: ready.length, progress: { done: ready.length, total: Math.max(1, normalized.length), message: 'warming up' } });
    if ((Date.now() - warmupStartedAt) < warmupMaxMs && ready.length < normalized.length) {
      runner.warmupTimer = setTimeout(warmupTick, 300);
      return;
    }
    if (ready.length < 30) {
      finish({ status: 'ERROR', message: 'Not enough symbols ready for search', error: { code: 'WARMUP_NOT_READY', message: 'Not enough symbols ready for search' } });
      return;
    }
    runScreening(ready);
  };

  runner.warmupTimer = setTimeout(warmupTick, 0);
  return { ok: true, active: true, state: leadLagSearchState };
}

function stopLeadLagSearch({ reason = 'stopped', preserveRows = false, releaseFeed = true, silent = false } = {}) {
  const runner = leadLagSearchRunner;
  if (runner) {
    runner.active = false;
    runner.cancel = true;
    if (runner.warmupTimer) clearTimeout(runner.warmupTimer);
    if (runner.handle) clearImmediate(runner.handle);
  }
  leadLagSearchRunner = null;
  leadLagSearchActive = false;
  if (releaseFeed) subscriptions.removeIntent('leadlag-search');
  leadLagSearchState = preserveRows
    ? { ...leadLagSearchState, searchActive: false, status: 'FINISHED', phase: 'FINISHED', message: reason, updatedAtMs: Date.now() }
    : { ...createIdleSearchState(), message: reason, status: 'IDLE', phase: 'IDLE' };
  if (!silent) emitLeadLagState({ force: true, bumpSeq: true });
  return leadLagSearchState;
}

setInterval(() => broadcast({ type: "universe.status", payload: universe.getStatus() }), 30000);
setInterval(() => broadcastEvent("bots.overview", getBotsOverview()), 2000);
setInterval(async () => {
  try {
    const ts = tradeStatus(tradeExecutor);
    if (!["demo", "real"].includes(ts.executionMode) || !ts.enabled) return;
    const symbol = "BTCUSDT";
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
  sendLeadLagEventNow(ws, 'leadlag.state', toLeadLagStateSnapshot({ bumpSeq: false }));

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    const rpcId = msg?.id ?? null;
    const rpcMethod = typeof msg?.method === 'string' ? msg.method : null;
    if (rpcMethod) {
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const rpcOk = (result) => safeSend(ws, { id: rpcId, result });
      if (rpcMethod === 'leadlag.getState') { rpcOk(toLeadLagStateSnapshot({ bumpSeq: false })); return; }
      if (rpcMethod === 'leadlag.trading.start') {
        const presetId = presetsStore.getState().activePresetId;
        const settings = { ...(params || {}), leaderSymbol: params?.leader, followerSymbol: params?.follower };
        const leader = String(settings?.leaderSymbol || 'BTCUSDT').toUpperCase();
        const follower = String(settings?.followerSymbol || 'ETHUSDT').toUpperCase();
        subscriptions.replaceIntent('leadlag-trading', { symbols: [leader, follower], streamType: 'ticker' });
        stopLeadLagSearch({ reason: 'stopped: trading started', preserveRows: false, releaseFeed: true });
        const result = paperTest.start({ presetId, mode: 'paper', settings });
        rpcOk({ ok: Boolean(result?.ok) });
        emitLeadLagState({ force: true, bumpSeq: true });
        return;
      }
      if (rpcMethod === 'leadlag.trading.stop') { paperTest.stop({ reason: params?.reason || 'manual' }); subscriptions.removeIntent('leadlag-trading'); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.trading.reset') { paperTest.stop({ reason: 'reset' }); subscriptions.removeIntent('leadlag-trading'); stopLeadLagSearch({ reason: 'stopped: reset', preserveRows: false, releaseFeed: true, silent: true }); paperTest.reset(); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.start') { const result = startLeadLagSearch(getUniverseAllSymbols(), params || {}); rpcOk({ ok: Boolean(result?.ok), active: Boolean(result?.active) }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.stop') { stopLeadLagSearch({ reason: 'stopped', preserveRows: false, releaseFeed: true, silent: true }); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.reset') { stopLeadLagSearch({ reason: 'reset', preserveRows: false, releaseFeed: true, silent: true }); leadLagSearchState = createIdleSearchState(); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
    }
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
      subscriptions.replaceIntent("leadlag-trading", { symbols: [leader, follower], streamType: 'ticker' });
      stopLeadLagSearch({ reason: 'stopped: trading started', preserveRows: false, releaseFeed: true });
      const result = paperTest.start({ presetId, mode: msg.mode || "paper", settings });
      const currentState = paperTest.getState();
      emitLeadLagState({ force: true, bumpSeq: true });
      broadcastBotsOverview();
      safeSend(ws, { type: "leadlag.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      safeSend(ws, { type: "paper.start.ack", payload: { ok: Boolean(result?.ok), state: currentState, settings: currentState?.settings || settings } });
      return;
    }

    if (msg.type === "stopPaperTest" || msg.type === "stopLeadLag") {
      paperTest.stop({ reason: "manual" });
      subscriptions.removeIntent("leadlag-trading");
      const currentState = paperTest.getState();
      emitLeadLagState({ force: true, bumpSeq: true });
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
      subscriptions.removeIntent("leadlag-trading");
      subscriptions.removeIntent("leadlag-search");
      stopLeadLagSearch({ reason: 'stopped: reset', preserveRows: false, releaseFeed: true });
      const payload = paperTest.reset();
      const currentState = paperTest.getState();
      emitLeadLagState({ force: true, bumpSeq: true });
      broadcastBotsOverview();
      safeSend(ws, { type: "leadlag.reset.ack", payload: { ...(payload || {}), state: currentState, searchState: leadLagSearchState } });
      return;
    }

    if (msg.type === "getPaperState" || msg.type === "getLeadLagState") {
      const state = paperTest.getState();
      sendLeadLagEventNow(ws, 'leadlag.state', toLeadLagStateSnapshot({ bumpSeq: false }));
      safeSend(ws, { type: "paper.state", payload: state });
      return;
    }

    if (msg.type === "leadlag.setAutoTuneConfig") {
      const payload = paperTest.setAutoTuneConfig(msg?.payload && typeof msg.payload === 'object' ? msg.payload : msg?.settings && typeof msg.settings === 'object' ? msg.settings : {});
      safeSend(ws, { type: "leadlag.autotune.ack", payload: { ok: true, config: payload?.autoTuneConfig || null } });
      sendLeadLagEventNow(ws, 'leadlag.state', toLeadLagStateSnapshot({ bumpSeq: false }));
      return;
    }

    if (msg.type === "leadlag.clearLearningLog") {
      const payload = paperTest.clearLearningLog();
      safeSend(ws, { type: "leadlag.learningLog.cleared", payload: { ok: true } });
      sendLeadLagEventNow(ws, 'leadlag.state', toLeadLagStateSnapshot({ bumpSeq: false }));
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


  });

  ws.on("close", () => { stopStatusWatcher(ws); clients.delete(ws); });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`server on http://${HOST}:${PORT}`);

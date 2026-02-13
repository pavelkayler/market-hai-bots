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
import { createSubscriptionManager } from "../subscriptionManager.js";
import { createLeadLagLive } from "../leadLagLive.js";
import { createLeadLagSearchV2 } from "../leadLagSearchV2.js";
import { createLeadLagLearning } from "../leadLagLearning.js";
import { createMomentumMarketData } from "../services/momentum/momentumMarketData.js";
import { createMomentumSqlite } from "../services/momentum/momentumSqlite.js";
import { createMomentumManager } from "../services/momentum/momentumManager.js";

dotenv.config();

const app = Fastify({ logger: true });
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const WS_OPEN = WebSocket.OPEN;

await app.register(cors, { origin: ["http://localhost:5173", "http://127.0.0.1:5173"] });
await app.register(websocket);

const clients = new Set();
const wsMeta = new Map();
function safeSend(ws, obj) {
  if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (!ws || ws.readyState !== WS_OPEN || isHighBackpressure(ws)) continue;
    ws.send(msg);
  }
}

function sendEvent(ws, topic, payload) {
  safeSend(ws, { type: "event", topic, payload });
}

function normalizeTopicList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const topic = value.trim();
    if (!topic) continue;
    out.push(topic);
  }
  return out;
}

function topicMatches(filter, topic) {
  if (filter === '*') return true;
  if (filter.endsWith('.*')) return topic.startsWith(filter.slice(0, -1));
  return filter === topic;
}

function wsSubscribedToTopic(ws, topic) {
  const meta = wsMeta.get(ws);
  if (!meta) return false;
  for (const filter of meta.topics) {
    if (topicMatches(filter, topic)) return true;
  }
  return false;
}

function hasAnyTopicSubscribers(topicFilters = []) {
  for (const ws of clients) {
    if (!ws || ws.readyState !== WS_OPEN) continue;
    const meta = wsMeta.get(ws);
    if (!meta) continue;
    for (const filter of topicFilters) {
      if (wsSubscribedToTopic(ws, filter)) return true;
    }
  }
  return false;
}

function broadcastEvent(topic, payload) {
  const msg = JSON.stringify({ type: "event", topic, payload });
  for (const ws of clients) {
    if (!ws || ws.readyState !== WS_OPEN || isHighBackpressure(ws)) continue;
    if (!wsSubscribedToTopic(ws, topic)) continue;
    ws.send(msg);
  }
}

function isHighBackpressure(ws) {
  return Number(ws?.bufferedAmount || 0) > LEADLAG_EMIT_LIMITS.wsBufferedAmountLimit;
}

function sendLeadLagEventNow(ws, topic, payload) { sendEvent(ws, topic, payload); }

const leadLagEmitState = {
  leadlagState: { payload: null, timer: null, lastAt: 0 },
  leadlagSearchProgress: { payload: null, timer: null, lastAt: 0 },
  leadlagSearchResults: { payload: null, timer: null, lastAt: 0 },
};

function broadcastLeadLagManaged({ topic, payload, bucket = 'leadlagState', intervalMs = 250, force = false } = {}) {
  if (force) {
    for (const ws of clients) { if (!wsSubscribedToTopic(ws, topic) || isHighBackpressure(ws)) continue; sendLeadLagEventNow(ws, topic, payload); }
    return;
  }
  const st = leadLagEmitState[bucket];
  if (!st) {
    for (const ws of clients) {
      if (isHighBackpressure(ws) || !wsSubscribedToTopic(ws, topic)) continue;
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
      if (isHighBackpressure(ws) || !wsSubscribedToTopic(ws, topic)) continue;
      sendLeadLagEventNow(ws, topic, out);
    }
  };
  const due = Math.max(0, intervalMs - (Date.now() - Number(st.lastAt || 0)));
  if (due <= 0) flush();
  else if (!st.timer) st.timer = setTimeout(flush, due);
}

const DEFAULT_SYMBOL_LIMIT = Number(process.env.DEFAULT_SYMBOL_LIMIT || 500);
const SEARCH_BUCKET_MS = 250;

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

function getTradeStatePayload() {
  return {
    executionMode: tradeExecutor.getExecutionMode(),
    killSwitch: tradeExecutor.getKillSwitch(),
    tradeStatus: tradeStatus(tradeExecutor),
    warnings: tradeWarnings(tradeExecutor),
    activeSymbol: tradeExecutor.getActiveSymbol?.() || null,
  };
}

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
    guardrails: tradeExecutor?.getGuardrails?.() || {
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


const marketData = createMarketDataStore();
const marketBars = createMicroBarAggregator({
  bucketMs: 250,
  keepMs: 120000,
  onBar: (bar) => {
    if (!hasAnyTopicSubscribers(['bybit.bar', 'market.bar'])) return;
    broadcastEvent('bybit.bar', bar);
    broadcastEvent('market.bar', bar);
  },
});
const leadLag = createLeadLag({ bucketMs: 250, maxLagMs: 1000, minSamples: 200, impulseZ: 2.0, minImpulses: 5 });
let lastLeadLagTop = [];
let leadLagSearchActive = false;
const LEADLAG_EMIT_LIMITS = {
  stateMs: 500,
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
    params: {
      universeSize: 300,
      topK: 50,
      warmupSec: 15,
      timeBudgetMs: 8,
      maxPairsPerTick: 2000,
      lagsMs: [250, 500, 750, 1000],
      confirmWindowSec: 120,
      responseWindowMs: 1000,
      followerThrMult: 0.5,
      followerAbsFloor: 0.00005,
      minSamples: 20,
      minImpulses: 10,
      minCorr: 0.08,
      minConfirmations: 3,
      impulseZ: 1.5,
      maxCorrSamples: 300,
    },
    load: { subscribedSymbols: 0, reducedSymbols: 0, cpuMsPerSec: 0, backlog: 0 },
    results: { updatedAtMs: Date.now(), top: [] },
    error: null,
    lastUpdateAt: Date.now(),
  };
}
let leadLagSearchState = createIdleSearchState();
let leadLagSearchRunner = null;

const leadLagLearning = createLeadLagLearning({
  filePath: "backend/data/leadlag_episodes.jsonl",
  onState: (payload) => broadcastLeadLagManaged({ topic: "leadlag.learning.state", payload, bucket: "leadlagState", intervalMs: 500, force: false }),
});

const leadLagSearchV2 = createLeadLagSearchV2({
  getUniverseSymbols: () => getUniverseAllSymbols(),
  getBars: (symbol, n = 260, source = "BT") => marketBars.getBars(symbol, n, source),
  onState: (payload) => broadcastLeadLagManaged({ topic: "leadlag.search.state", payload, bucket: "leadlagSearchProgress", intervalMs: 250, force: false }),
  onShortlist: (payload) => broadcastLeadLagManaged({ topic: "leadlag.search.shortlist", payload, bucket: "leadlagSearchResults", intervalMs: 1000, force: false }),
  onLog: (payload) => broadcastLeadLagManaged({ topic: "leadlag.log", payload, bucket: null, force: false }),
});

const bybit = createBybitPublicWs({
  symbols: [],
  logger: app.log,
  enableLiquidations: true,
  onStatus: (s) => broadcast({ type: "bybit.status", payload: s }),
  onTicker: (t) => {
    const normalized = marketData.upsertTicker({ ...t, source: "BT" });
    if (!normalized) return;
    marketBars.ingest(normalized);
    if (hasAnyTopicSubscribers(['bybit.ticker'])) broadcastEvent('bybit.ticker', normalized);
    if (hasAnyTopicSubscribers(['market.ticker'])) broadcastEvent('market.ticker', normalized);
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
const momentumSqlite = createMomentumSqlite({ logger: app.log });
await momentumSqlite.init();
const momentumMarketData = createMomentumMarketData({ logger: app.log });
await momentumMarketData.start();
const momentumManager = createMomentumManager({ marketData: momentumMarketData, sqlite: momentumSqlite, logger: app.log });
momentumManager.onState((payload) => broadcastEvent('momentum.state', payload));
function handleLeadLagEngineEvent({ type, payload }) {
  if (type === 'leadlag.state') {
    emitLeadLagState({ force: false, bumpSeq: true });
  } else if (type === 'leadlag.log') {
    broadcastLeadLagManaged({ topic: 'leadlag.log', payload, bucket: null, force: false });
  } else if (type === 'leadlag.trade' || type === 'paper.trade') {
    broadcastLeadLagManaged({ topic: 'leadlag.tradeEvent', payload, bucket: null, force: true });
    if (String(payload?.event || '').toUpperCase() === 'CLOSE') {
      const params = leadLagLearning.getActiveParams();
      leadLagLearning.onEpisode({
        ts: Number(payload?.ts || Date.now()),
        leader: String(payload?.leader || paperTest?.getState?.()?.settings?.leaderSymbol || '').toUpperCase() || null,
        follower: String(payload?.symbol || payload?.follower || paperTest?.getState?.()?.settings?.followerSymbol || '').toUpperCase() || null,
        mode: tradeExecutor.getExecutionMode(),
        params,
        side: payload?.side || null,
        entryPrice: Number(payload?.entryPrice || 0) || null,
        exitPrice: Number(payload?.exitPrice || 0) || null,
        pnlUSDT: Number(payload?.pnlUSDT || 0) || 0,
        feesUSDT: Number(payload?.feesUSDT || 0) || 0,
        fundingUSDT: Number(payload?.fundingUSDT || 0) || 0,
        slippageUSDT: Number(payload?.slippageUSDT || 0) || 0,
        durationSec: Math.max(0, Math.round((Number(payload?.ts || 0) - Number(payload?.openedAt || 0)) / 1000)),
        outcome: { win: Number(payload?.pnlUSDT || 0) >= 0, rMultiple: null },
      });
    }
  } else {
    broadcast({ type, payload });
  }
}

const paperTest = createPaperTest({
  getLeadLagTop: () => lastLeadLagTop,
  getMarketTicker: (symbol, source) => marketData.getTicker(symbol, source),
  getUniverseSymbols: () => universe.getUniverse({ limit: 500 }).symbols,
  logger: app.log,
  onEvent: handleLeadLagEngineEvent,
});
const leadLagLive = createLeadLagLive({ marketData, tradeExecutor, logger: app.log, onEvent: handleLeadLagEngineEvent });
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

function isLeadLagRunning() {
  const paperStatus = String(paperTest.getState?.({ includeHistory: false })?.status || 'STOPPED').toUpperCase();
  const liveStatus = String(leadLagLive.getState?.({ includeHistory: false })?.status || 'STOPPED').toUpperCase();
  return ['RUNNING', 'STARTING'].includes(paperStatus) || ['RUNNING', 'STARTING'].includes(liveStatus);
}

function getActiveTradeSymbol() {
  const active = tradeExecutor.getActiveSymbol?.();
  if (active) return active;
  const mode = tradeExecutor.getExecutionMode();
  if (mode !== 'paper') {
    const live = leadLagLive.getState?.({ includeHistory: false }) || {};
    if (['RUNNING', 'STARTING'].includes(String(live?.status || '').toUpperCase())) return String(live?.settings?.followerSymbol || '').toUpperCase() || null;
  } else {
    const paper = paperTest.getState?.({ includeHistory: false }) || {};
    if (['RUNNING', 'STARTING'].includes(String(paper?.status || '').toUpperCase())) return String(paper?.settings?.followerSymbol || '').toUpperCase() || null;
  }
  return null;
}


function mapTradingStatus(status) {
  const normalized = String(status || 'STOPPED').toUpperCase();
  if (normalized === 'STOPPING') return 'STOPPED';
  if (normalized === 'RUNNING' || normalized === 'STARTING' || normalized === 'STOPPED') return normalized;
  return 'STOPPED';
}

function toLeadLagStateSnapshot({ bumpSeq = true } = {}) {
    const executionMode = tradeExecutor.getExecutionMode();
  const trading = (executionMode === 'paper'
    ? paperTest.getState({ includeHistory: false })
    : leadLagLive.getState({ includeHistory: false })) || {};
  const search = leadLagSearchV2.getState?.() || leadLagSearchState || createIdleSearchState();
  const learning = leadLagLearning.getState?.() || {};
  if (bumpSeq) leadLagSnapshotSeq += 1;

  const leader = String(trading?.settings?.leaderSymbol || trading?.manual?.leaderSymbol || 'BTCUSDT').toUpperCase();
  const follower = String(trading?.settings?.followerSymbol || trading?.manual?.followerSymbol || 'ETHUSDT').toUpperCase();
  const leaderTicker = marketData.getTicker(leader, 'BT') || {};
  const followerTicker = marketData.getTicker(follower, 'BT') || {};
  const topRows = Array.isArray(search?.results?.top) ? search.results.top : Array.isArray(search?.topRows) ? search.topRows : [];

  const lastTs = Number(trading?.currentTradeEvents?.[0]?.ts);
  const payload = {
    schemaVersion: 1,
    snapshotSeq: leadLagSnapshotSeq,
    serverTimeMs: Date.now(),
    trading: {
      status: mapTradingStatus(trading?.status),
      runId: trading?.currentRunKey || trading?.runKey || null,
      startedAtMs: Number(trading?.startedAt || 0) || null,
      stoppedAtMs: Number(trading?.endedAt || 0) || null,
      pair: { leader, follower },
      params: {
        triggerPct: Number(trading?.settings?.leaderMovePct ?? 0.1),
        tpPct: Number(trading?.settings?.followerTpPct ?? 0.1),
        slPct: Number(trading?.settings?.followerSlPct ?? 0.1),
        maxConcurrent: executionMode === 'paper' ? 5 : 1,
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
        lastEventAgeMs: Number.isFinite(lastTs) ? Math.max(0, Date.now() - lastTs) : null,
      },
      positions: (Array.isArray(trading?.positions) ? trading.positions : []).slice(0, 5),
      tradeEvents: (Array.isArray(trading?.currentTradeEvents) ? trading.currentTradeEvents : []).slice(0, 20),
      history: (Array.isArray(trading?.currentClosedTrades) ? trading.currentClosedTrades : []).slice(0, 50),
      noEntryReasons: (Array.isArray(trading?.lastNoEntryReasons) ? trading.lastNoEntryReasons : []).slice(0, 5),
      execution: {
        mode: executionMode,
        enabled: Boolean(tradeExecutor?.enabled?.()),
        killSwitch: Boolean(tradeExecutor?.getKillSwitch?.()),
        warnings: tradeWarnings(tradeExecutor),
        baseUrl: process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com',
        demo: /api-demo\.bybit\.com/i.test(process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com'),
        real: /api\.bybit\.com/i.test(process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com'),
      },
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
          leader: r?.leader,
          follower: r?.follower,
          lagMs: Number(r?.lagMs || 0),
          confirmations: Number(r?.confirmations || 0),
          corr: Number(r?.corr || 0),
          samples: Number(r?.samples || 0),
          impulses: Number(r?.impulses || 0),
          confirmed: Boolean(r?.confirmed),
          tradeReady: Boolean(r?.tradeReady),
          blockers: Array.isArray(r?.blockers) ? r.blockers.slice(0, 3) : [],
          lastSeenAgeMs: Number(r?.lastSeenAgeMs || 0),
        })),
      },
      error: search?.error || null,
    },
    learning,
  };
  return payload;
}

function createFallbackLeadLagSnapshot({ where = 'snapshot', err = null, bumpSeq = false } = {}) {
  if (bumpSeq) leadLagSnapshotSeq += 1;
  const now = Date.now();
  return {
    schemaVersion: 1,
    snapshotSeq: leadLagSnapshotSeq,
    serverTimeMs: now,
    trading: {
      status: 'STOPPED',
      runId: null,
      startedAtMs: null,
      stoppedAtMs: null,
      pair: { leader: 'BTCUSDT', follower: 'ETHUSDT' },
      params: {},
      baseline: { leader0: null, follower0: null },
      prices: {
        leader: { mark: null, last: null, tsMs: null },
        follower: { mark: null, last: null, tsMs: null },
      },
      telemetry: { leaderMovePct: 0, followerMovePct: 0, lastUpdateMs: now, lastEventAgeMs: null },
      positions: [],
      tradeEvents: [],
      history: [],
      stats: { line1: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnl: 0 }, line2: { fees: 0, funding: 0, slippage: 0, feeRateBps: 0 } },
    },
    search: {
      status: 'ERROR',
      jobId: null,
      startedAtMs: null,
      updatedAtMs: now,
      params: createIdleSearchState().params,
      progress: { phase: 'ERROR', done: 0, total: 0, pct: 0, message: 'snapshot error', lastTickMs: now },
      load: { subscribedSymbols: 0, reducedSymbols: 0, cpuMsPerSec: 0, backlog: 0 },
      results: { updatedAtMs: now, top: [] },
      error: null,
    },
    error: { message: String(err?.message || err || 'snapshot build failed'), where },
  };
}

function safeLeadLagSnapshot({ bumpSeq = true, where = 'snapshot' } = {}) {
  try {
    return toLeadLagStateSnapshot({ bumpSeq });
  } catch (err) {
    app.log.error({ err, where }, 'leadlag snapshot build failed');
    return createFallbackLeadLagSnapshot({ where, err, bumpSeq });
  }
}

function emitLeadLagState({ force = false, bumpSeq = true } = {}) {
  if (!force && !hasAnyTopicSubscribers(['leadlag.state'])) return null;
  const snapshot = safeLeadLagSnapshot({ bumpSeq, where: 'emitLeadLagState' });
  broadcastLeadLagManaged({ topic: 'leadlag.state', payload: snapshot, bucket: 'leadlagState', intervalMs: LEADLAG_EMIT_LIMITS.stateMs, force });
  return snapshot;
}

function getSnapshotPayload({ full = false } = {}) {
  const allTickers = marketData.getTickersArray();
  const cappedTickers = allTickers.slice(0, 100);
  return {
    now: Date.now(),
    bybit: bybit.getStatus(),
    symbols: bybit.getSymbols(),
    symbolLimit: DEFAULT_SYMBOL_LIMIT,
    leadlagState: safeLeadLagSnapshot({ bumpSeq: false, where: 'getSnapshotPayload' }),
    botsOverview: getBotsOverview(),
    tradeStatus: tradeStatus(tradeExecutor),
    warnings: tradeWarnings(tradeExecutor),
    tradePositions: [],
    tradeOrders: [],
    ...(full ? { marketTickers: cappedTickers, bybitTickers: cappedTickers.filter((t) => t?.source === 'BT') } : {}),
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
    const mode = tradeExecutor.getExecutionMode();
  const leadlagState = mode === 'paper'
    ? (paperTest.getState?.({ includeHistory: false }) || paperTest.getState?.() || {})
    : (leadLagLive.getState?.({ includeHistory: false }) || leadLagLive.getState?.() || {});
  const paperBalance = Number(process.env.PAPER_WALLET_BALANCE || 10000);
  return {
    ts: Date.now(),
    paperBalance,
    bots: [
      { name: "LeadLag", status: leadlagState.status || "STOPPED", pnl: Number(leadlagState?.stats?.pnlUSDT ?? toBotPnl(leadlagState)), startedAt: leadlagState.startedAt || null },
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

function pearsonFromSums({ n, sumX, sumY, sumX2, sumY2, sumXY }) {
  if (!(n > 1)) return 0;
  const numerator = (n * sumXY) - (sumX * sumY);
  const denX = (n * sumX2) - (sumX ** 2);
  const denY = (n * sumY2) - (sumY ** 2);
  const denominator = Math.sqrt(Math.max(0, denX * denY));
  if (!(denominator > 0)) return 0;
  const corr = numerator / denominator;
  if (!Number.isFinite(corr)) return 0;
  return Math.max(-1, Math.min(1, corr));
}

function sumWindowReturns(returnsMap, startTs, bucketMs, windowMs) {
  const outBucketMs = Math.max(1, Number(bucketMs || SEARCH_BUCKET_MS));
  const outWindowMs = Math.max(0, Number(windowMs || 0));
  let sum = 0;
  for (let t = Number(startTs || 0); t <= Number(startTs || 0) + outWindowMs; t += outBucketMs) {
    sum += Number(returnsMap?.get(t) || 0);
  }
  return sum;
}

function buildSymbolFeature(symbol, bars, impulseZ = 2) {
  const { map, returns } = mapReturns(bars);
  const st = stdDev(returns);
  const threshold = Math.max(st * impulseZ, 0.00005);
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
  const requestedUniverseSize = Number(params.universeSize);
  const universeLimit = Number.isFinite(requestedUniverseSize)
    ? Math.max(30, Math.min(500, Math.trunc(requestedUniverseSize)))
    : 300;
  params.universeSize = universeLimit;
  const cappedSymbols = normalized.slice(0, universeLimit);
  if (!cappedSymbols.length) {
    leadLagSearchState = { ...createIdleSearchState(), message: 'universe empty', status: 'ERROR', phase: 'ERROR', error: { code: 'UNIVERSE_EMPTY', message: 'universe empty' } };
    emitLeadLagState({ force: true, bumpSeq: true });
    return { ok: false, reason: 'UNIVERSE_EMPTY', state: leadLagSearchState };
  }

  subscriptions.replaceIntent('leadlag-search', { symbols: cappedSymbols, streamType: 'ticker' });
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
      next.progress.total = Math.max(1, Number(next.symbolsTotal || 1));
    }
    next.progress.pct = next.progress.total > 0 ? Math.max(0, Math.min(100, (Number(next.progress.done || 0) / Number(next.progress.total || 1)) * 100)) : 0;
    next.progress.lastTickMs = Date.now();
    next.load = {
      ...(next.load || {}),
      subscribedSymbols: Number(next.subscribedSymbols || next.symbolsTotal || 0),
      reducedSymbols: Number(next.reducedSymbols || 0),
      cpuMsPerSec: Number(runner.cpuMs || 0),
      backlog: Math.max(0, Number(next.progress.total || 0) - Number(next.progress.done || 0)),
    };
    next.results = { updatedAtMs: Date.now(), top: (next.topRows || []).slice(0, 50) };
    leadLagSearchState = next;
    pushProgress(force);
  };

  const finish = ({ status = 'FINISHED', message = 'finished', error = null } = {}) => {
    if (!runner.active) return;
    runner.active = false;
    runner.cancel = true;
    if (runner.warmupTimer) clearTimeout(runner.warmupTimer);
    if (runner.handle) clearImmediate(runner.handle);
    runner.warmupTimer = null;
    runner.handle = null;
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
        total: Number(leadLagSearchState.progress?.total || 1),
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
    symbolsTotal: cappedSymbols.length,
    subscribedSymbols: cappedSymbols.length,
    params,
    progress: { phase: 'WARMUP', done: 0, total: Math.max(1, cappedSymbols.length), pct: 0, message: 'warming up', lastTickMs: startedAt },
  };
  pushProgress(true);

  const warmupStartedAt = Date.now();
  const warmupMaxMs = Math.max(1, Number(params.warmupSec || 15) * 1000);
  const minBars = 60;

  const runConfirmations = (candidates, features) => {
    if (!runner.active || runner.cancel) return;
    if (!candidates.length) {
      finish({ status: 'FINISHED', message: 'finished: no candidates' });
      return;
    }

    const reducedSymbols = [...new Set(candidates.slice(0, 300).flatMap((row) => [row.leader, row.follower]))].slice(0, 80);
    subscriptions.replaceIntent('leadlag-search', { symbols: reducedSymbols, streamType: 'ticker' });
    updateState({ status: 'CONFIRMATIONS', phase: 'CONFIRMATIONS', message: 'confirmations', reducedSymbols: reducedSymbols.length, subscribedSymbols: reducedSymbols.length, progress: { done: 0, total: Math.max(1, candidates.length), message: 'confirmations' } }, true);

    let idx = 0;
    const rows = [];
    const total = candidates.length;

    const confTick = () => {
      if (!runner.active || runner.cancel) return;
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
        const lagMs = Number(row?.lagMs || 0);
        const responseWindowMs = Math.max(SEARCH_BUCKET_MS, Number(params.responseWindowMs || 1000));
        const followerThrMult = Math.max(0, Number(params.followerThrMult || 0.5));
        const followerAbsFloor = Math.max(0.00001, Number(params.followerAbsFloor || 0.00005));
        const followerMoveThr = Math.max(Number(ff.threshold || 0) * followerThrMult, followerAbsFloor);
        const confirmWindowMs = Math.max(10_000, Number(params.confirmWindowSec || 120) * 1000);
        const maxCorrSamples = Math.max(20, Number(params.maxCorrSamples || 300));
        const minCorr = Math.max(0, Number(params.minCorr || 0.08));
        const minSamples = Math.max(5, Number(params.minSamples || 20));
        const minImpulses = Math.max(1, Number(params.minImpulses || 10));
        const minConfirmations = Math.max(1, Number(params.minConfirmations || 3));
        const now = Date.now();
        const leaderImpulseTimes = lf.impulseTimes.filter((ts) => (now - Number(ts || 0)) <= confirmWindowMs);
        let n = 0;
        let sumX = 0;
        let sumY = 0;
        let sumX2 = 0;
        let sumY2 = 0;
        let sumXY = 0;
        let confirmations = 0;
        for (const tsL of leaderImpulseTimes) {
          const x = lf.returnsMap.get(tsL);
          const y = sumWindowReturns(ff.returnsMap, tsL + lagMs, SEARCH_BUCKET_MS, responseWindowMs);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          n += 1;
          sumX += x;
          sumY += y;
          sumX2 += x * x;
          sumY2 += y * y;
          sumXY += x * y;
          if (Math.sign(x) === Math.sign(y) && Math.abs(y) >= followerMoveThr) confirmations += 1;
          if (n >= maxCorrSamples) break;
        }
        const corr = pearsonFromSums({ n, sumX, sumY, sumX2, sumY2, sumXY });
        const impulses = leaderImpulseTimes.length;
        const confirmed = Math.abs(corr) >= minCorr
          && n >= minSamples
          && impulses >= minImpulses
          && confirmations >= minConfirmations;
        const tsLeader = Number(marketData.getTicker(row?.leader, 'BT')?.ts || 0);
        const tsFollower = Number(marketData.getTicker(row?.follower, 'BT')?.ts || 0);
        const lastSeenAgeMs = (tsLeader > 0 && tsFollower > 0)
          ? Math.max(0, Date.now() - Math.max(tsLeader, tsFollower))
          : null;

        let tradeReady = false;
        let blockers = [];
        try {
          const excludedCoins = [];
          const currentEvents = paperTest.getState({ includeHistory: false })?.currentTradeEvents || [];
          const lastTradeAt = currentEvents.find((evt) => String(evt?.event || '').toUpperCase() === 'CLOSE')?.ts || null;
          const readiness = evaluateTradeReady({
            row: { ...row, corr, samples: n, impulses, confirmed, confirmations },
            preset: null,
            excludedCoins,
            lastTradeAt,
            getBars: (sym, barsN) => marketBars.getBars(sym, barsN, 'BT'),
            bucketMs: 250,
          });
          tradeReady = Boolean(readiness?.tradeReady);
          blockers = Array.isArray(readiness?.blockers) ? readiness.blockers.slice(0, 3) : [];
        } catch (err) {
          tradeReady = false;
          blockers = [{ key: 'READINESS_ERROR', detail: String(err?.message || err || 'unknown') }];
        }

        rows.push({
          ...row,
          lagMs,
          source: 'BT',
          corr,
          samples: n,
          impulses,
          confirmations,
          confirmed,
          tradeReady,
          blockers,
          lastSeenAgeMs,
        });
      }
      runner.cpuMs = Math.round((runner.cpuMs * 0.7) + ((performance.now() - tickStart) * 0.3));
      rows.sort((a, b) => Number(b.tradeReady) - Number(a.tradeReady)
        || Number(b.confirmed) - Number(a.confirmed)
        || Number(b.confirmations || 0) - Number(a.confirmations || 0)
        || Math.abs(Number(b.corr || 0)) - Math.abs(Number(a.corr || 0))
        || Math.abs(Number(a.lagMs || 0)) - Math.abs(Number(b.lagMs || 0)));
      const topRows = rows.slice(0, Math.max(50, Number(params.topK || 50)));
      lastLeadLagTop = topRows.slice(0, 50);
      paperTest.setSearchRows?.(lastLeadLagTop);
      updateState({ topRows: lastLeadLagTop, confirmationsDone: idx, confirmationsTarget: total, progress: { done: idx, total: Math.max(1, total), message: 'confirmations' } });
      if (idx >= total) {
        finish({ status: 'FINISHED', message: 'finished' });
        return;
      }
      if (!runner.active || runner.cancel) return;
      runner.handle = setImmediate(confTick);
    };

    if (!runner.active || runner.cancel) return;
    runner.handle = setImmediate(confTick);
  };

  const runScreening = (readySymbols) => {
    if (!runner.active || runner.cancel) return;
    const lags = (Array.isArray(params.lagsMs) ? params.lagsMs : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0 && v <= 5000);
    const cleanLags = lags.length ? lags : [250, 500, 750, 1000];
    const impulseZ = Number(params.impulseZ ?? 1.5);
    const followerThrMult = Math.max(0, Number(params.followerThrMult || 0.5));
    const followerAbsFloor = Math.max(0.00001, Number(params.followerAbsFloor || 0.00005));
    const responseWindowMs = Math.max(SEARCH_BUCKET_MS, Number(params.responseWindowMs || 1000));
    const minImpulses = Math.max(1, Number(params.minImpulses || 10));
    const screeningMinConfirmations = Math.max(1, Number(params.screeningMinConfirmations || 1));
    const screeningMinImpulses = Math.max(1, Number(params.screeningMinImpulses || Math.min(5, minImpulses)));
    const windowMs = Math.max(10_000, Number(params.confirmWindowSec || 120) * 1000);
    const candidateCap = 5000;
    const features = new Map();

    let featureIdx = 0;
    const featureTotal = readySymbols.length;
    updateState({ status: 'SCREENING', phase: 'SCREENING', message: 'screening: building features', totalPairs: Math.max(1, featureTotal), progress: { done: 0, total: Math.max(1, featureTotal), message: 'screening: building features' } }, true);

    const scorePair = (leader, follower) => {
      const lf = features.get(leader);
      const ff = features.get(follower);
      if (!lf || !ff) return null;
      const followerMoveThr = Math.max(Number(ff.threshold || 0) * followerThrMult, followerAbsFloor);
      const now = Date.now();
      const leaderImpulseTimes = lf.impulseTimes.filter((ts) => (now - Number(ts || 0)) <= windowMs);
      const leaderImpulsesCount = leaderImpulseTimes.length;
      if (leaderImpulsesCount < screeningMinImpulses) return null;
      const tsLeader = Number(marketData.getTicker(leader, 'BT')?.ts || 0);
      const tsFollower = Number(marketData.getTicker(follower, 'BT')?.ts || 0);
      const lastSeenAgeMs = (tsLeader > 0 && tsFollower > 0)
        ? Math.max(0, now - Math.max(tsLeader, tsFollower))
        : Number.MAX_SAFE_INTEGER;
      let best = null;
      for (const lag of cleanLags) {
        let conf = 0;
        for (const tsL of leaderImpulseTimes) {
          const x = lf.returnsMap.get(tsL);
          const y = sumWindowReturns(ff.returnsMap, tsL + lag, SEARCH_BUCKET_MS, responseWindowMs);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          if (Math.sign(x) !== Math.sign(y)) continue;
          if (Math.abs(y) < followerMoveThr) continue;
          conf += 1;
        }
        if (!best || conf > best.confirmations) {
          best = {
            leader,
            follower,
            lagMs: lag,
            confirmations: conf,
            impulses: leaderImpulsesCount,
            score: conf,
            leaderImpulsesConsidered: leaderImpulsesCount,
            lastSeenAgeMs,
          };
        }
      }
      return best && best.confirmations >= screeningMinConfirmations ? best : null;
    };

    const buildFeaturesTick = () => {
      if (!runner.active || runner.cancel) return;
      const tickStart = performance.now();
      const budget = Math.max(1, Number(params.timeBudgetMs || 8));
      while ((performance.now() - tickStart) < budget && featureIdx < featureTotal) {
        const sym = readySymbols[featureIdx++];
        features.set(sym, buildSymbolFeature(sym, marketBars.getBars(sym, 500, 'BT') || [], impulseZ));
      }
      runner.cpuMs = Math.round((runner.cpuMs * 0.7) + ((performance.now() - tickStart) * 0.3));
      updateState({ progress: { done: featureIdx, total: Math.max(1, featureTotal), message: 'screening: building features' } });
      if (featureIdx >= featureTotal) {
        const withImpulses = [...features.values()].filter((f) => Array.isArray(f?.impulseTimes) && f.impulseTimes.length > 0).length;
        updateState({ message: `screening: ${withImpulses}/${featureTotal} symbols have impulses; responseWindow=${responseWindowMs}ms` }, true);
        runPairsScreening();
        return;
      }
      if (!runner.active || runner.cancel) return;
      runner.handle = setImmediate(buildFeaturesTick);
    };

    const n = readySymbols.length;
    const totalPairs = Math.max(0, n * (n - 1));
    let idx = 0;
    const candidates = [];

    const runPairsScreening = () => {
      updateState({ message: 'screening pairs', totalPairs, progress: { done: 0, total: Math.max(1, totalPairs), message: 'screening pairs' } }, true);

      const screeningTick = () => {
        if (!runner.active || runner.cancel) return;
        const tickStart = performance.now();
        const budget = Math.max(1, Number(params.timeBudgetMs || 8));
        const maxPerTick = Math.max(1, Number(params.maxPairsPerTick || 2000));
        let local = 0;
        const pendingCandidates = [];
        while ((performance.now() - tickStart) < budget && idx < totalPairs && local < maxPerTick) {
          local += 1;
          const i = Math.floor(idx / (n - 1));
          let j = idx % (n - 1);
          if (j >= i) j += 1;
          const scored = scorePair(readySymbols[i], readySymbols[j]);
          idx += 1;
          if (scored && typeof scored === 'object' && scored.leader && scored.follower) pendingCandidates.push(scored);
        }
        if (pendingCandidates.length) {
          candidates.push(...pendingCandidates);
          candidates.sort((a, b) => Number(b.confirmations || 0) - Number(a.confirmations || 0)
            || Number(b.leaderImpulsesConsidered || 0) - Number(a.leaderImpulsesConsidered || 0)
            || Number(a.lastSeenAgeMs || Number.MAX_SAFE_INTEGER) - Number(b.lastSeenAgeMs || Number.MAX_SAFE_INTEGER));
          if (candidates.length > candidateCap) candidates.length = candidateCap;
        }
        runner.cpuMs = Math.round((runner.cpuMs * 0.7) + ((performance.now() - tickStart) * 0.3));
        const screeningMsg = idx % 20000 < maxPerTick
          ? `screening pairs: kept ${candidates.length}`
          : 'screening pairs';
        updateState({ message: screeningMsg, topRows: candidates.slice(0, 50), candidatesKept: candidates.length, processedPairs: idx, progress: { done: idx, total: Math.max(1, totalPairs), message: screeningMsg } });
        if (idx >= totalPairs) {
          runConfirmations(candidates.slice(0, 1500), features);
          return;
        }
        if (!runner.active || runner.cancel) return;
        runner.handle = setImmediate(screeningTick);
      };

      if (!runner.active || runner.cancel) return;
      runner.handle = setImmediate(screeningTick);
    };

    if (!runner.active || runner.cancel) return;
    runner.handle = setImmediate(buildFeaturesTick);
  };

  const warmupTick = () => {
    if (!runner.active || runner.cancel) return;
    const ready = [];
    const minReady = 20;
    for (const sym of cappedSymbols) {
      const t = marketData.getTicker(sym, 'BT');
      if (!t || (Date.now() - Number(t.ts || 0)) > 30_000) continue;
      if ((marketBars.getBars(sym, 200, 'BT') || []).length >= minBars) ready.push(sym);
    }
    updateState({ symbolsReady: ready.length, progress: { done: ready.length, total: Math.max(1, cappedSymbols.length), message: 'warming up' } });
    if ((Date.now() - warmupStartedAt) < warmupMaxMs && ready.length < cappedSymbols.length) {
      runner.warmupTimer = setTimeout(warmupTick, 300);
      return;
    }
    if (ready.length < minReady) {
      finish({ status: 'ERROR', message: 'Not enough symbols ready for search', error: { code: 'WARMUP_NOT_READY', message: 'Not enough symbols ready for search' } });
      return;
    }
    subscriptions.replaceIntent('leadlag-search', { symbols: ready, streamType: 'ticker' });
    if (ready.length < cappedSymbols.length) {
      updateState({ subscribedSymbols: ready.length, message: `warmup partial: proceeding with ${ready.length} ready symbols` });
    } else {
      updateState({ subscribedSymbols: ready.length });
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
    runner.warmupTimer = null;
    runner.handle = null;
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
    if (!hasAnyTopicSubscribers(['trade.positions', 'trade.orders'])) return;
    const ts = tradeStatus(tradeExecutor);
    if (!["demo", "real"].includes(ts.executionMode) || !ts.enabled) return;
    const symbol = getActiveTradeSymbol();
    if (!symbol) return;
    const snap = await getTradeSnapshot(symbol);
    broadcastEvent("trade.positions", { ts: Date.now(), symbol, positions: (snap.positions || []).slice(0, 20) });
    broadcastEvent("trade.orders", { ts: Date.now(), symbol, orders: (snap.orders || []).slice(0, 50) });
  } catch {}
}, 2500);

app.get("/health", async () => {
  return {
    ok: true,
    ts: Date.now(),
    wsClients: clients.size,
    bybitConnected: Boolean(bybit.getStatus?.()?.connected),
    searchStatus: leadLagSearchV2.getState?.()?.phase || 'IDLE',
    tradingStatus: mapTradingStatus((tradeExecutor.getExecutionMode() === 'paper' ? paperTest.getState({ includeHistory: false }) : leadLagLive.getState({ includeHistory: false }))?.status),
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
app.get("/api/leadlag/state", async (req) => {
  const full = String(req.query?.full || '0') === '1';
  return tradeExecutor.getExecutionMode() === 'paper'
    ? paperTest.getState({ includeHistory: full })
    : leadLagLive.getState({ includeHistory: full });
});
app.get("/api/universe/status", async () => universe.getStatus());
app.get("/api/universe/list", async () => {
  const u = universe.getUniverse({ limit: 2000 }) || {};
  return { symbols: u.symbols || [], updatedAt: u.updatedAt || null };
});
app.get("/api/universe", async () => universe.getUniverse({ limit: 300 }));
app.post("/api/universe/refresh", async () => { await universe.refresh(); return universe.getStatus(); });
app.get("/api/trade/status", async () => ({ tradeStatus: tradeStatus(tradeExecutor), warnings: tradeWarnings(tradeExecutor) }));
app.get("/api/trade/state", async () => getTradeStatePayload());
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
app.post("/api/trade/killswitch", async (req) => {
  const enabled = tradeExecutor.setKillSwitch(Boolean(req.body?.enabled));
  const payload = getTradeStatePayload();
  broadcastEvent("trade.killswitch", { enabled });
  broadcastEvent("trade.state", payload);
  return { ok: true, enabled };
});
app.post('/api/trade/mode', async (req) => {
  const mode = String(req.body?.mode || 'paper').toLowerCase();
  if (isLeadLagRunning()) return { ok: false, reason: 'STOP_TRADING_FIRST' };
  tradeExecutor.setExecutionMode(mode);
  const payload = getTradeStatePayload();
  broadcastEvent('trade.state', payload);
  return { ok: true, ...payload };
});
app.post('/api/trade/guardrails', async (req) => {
  tradeExecutor.setGuardrails({
    maxNotional: req.body?.maxNotionalUsd,
    maxLeverage: req.body?.maxLeverage,
    maxActivePositions: req.body?.maxActivePositions,
  });
  const payload = getTradeStatePayload();
  broadcastEvent('trade.state', payload);
  return { ok: true, ...payload };
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
  wsMeta.set(ws, { id: Math.random().toString(36).slice(2), topics: new Set(), connectedAt: Date.now(), lastSeenAt: Date.now() });
  sendEvent(ws, 'server.hello', { now: Date.now() });

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
    const meta = wsMeta.get(ws);
    if (meta) meta.lastSeenAt = Date.now();
    const rpcId = msg?.id ?? null;
    const rpcMethod = typeof msg?.method === 'string' ? msg.method : null;
    try {
      if (rpcMethod) {
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const rpcOk = (result) => safeSend(ws, { id: rpcId, result });
      if (rpcMethod === 'leadlag.getState') { rpcOk(safeLeadLagSnapshot({ bumpSeq: false, where: 'rpc.leadlag.getState' })); return; }
      if (rpcMethod === 'trade.getState') { rpcOk(getTradeStatePayload()); return; }
      if (rpcMethod === 'momentum.start') { rpcOk(momentumManager.start(params?.config || {})); return; }
      if (rpcMethod === 'momentum.stop') { rpcOk(momentumManager.stop(params?.instanceId)); return; }
      if (rpcMethod === 'momentum.list') { rpcOk(momentumManager.list()); return; }
      if (rpcMethod === 'momentum.getState') { rpcOk(momentumManager.getState(params?.instanceId)); return; }
      if (rpcMethod === 'momentum.getPositions') { rpcOk(momentumManager.getPositions(params?.instanceId)); return; }
      if (rpcMethod === 'momentum.getTrades') { rpcOk(await momentumManager.getTrades(params?.instanceId, params?.limit, params?.offset)); return; }
      if (rpcMethod === 'momentum.getMarketStatus') { rpcOk(momentumManager.getMarketStatus()); return; }
      if (rpcMethod === 'momentum.cancelEntry') { rpcOk(momentumManager.cancelEntry(params?.instanceId, params?.symbol)); return; }
      if (rpcMethod === 'trade.setMode') {
        const mode = String(params?.mode || 'paper').toLowerCase();
        if (isLeadLagRunning()) { rpcOk({ ok: false, reason: 'STOP_TRADING_FIRST' }); return; }
        tradeExecutor.setExecutionMode(mode);
        const payload = getTradeStatePayload();
        broadcastEvent('trade.state', payload);
        rpcOk({ ok: true, ...payload });
        return;
      }
      if (rpcMethod === 'trade.setKillSwitch') {
        const enabled = tradeExecutor.setKillSwitch(Boolean(params?.enabled));
        const payload = getTradeStatePayload();
        broadcastEvent('trade.killswitch', { enabled });
        broadcastEvent('trade.state', payload);
        rpcOk({ ok: true, ...payload });
        return;
      }
      if (rpcMethod === 'trade.setGuardrails') {
        tradeExecutor.setGuardrails({
          maxNotional: params?.maxNotionalUsd,
          maxLeverage: params?.maxLeverage,
          maxActivePositions: params?.maxActivePositions,
        });
        const payload = getTradeStatePayload();
        broadcastEvent('trade.state', payload);
        rpcOk({ ok: true, ...payload });
        return;
      }
      if (rpcMethod === 'trade.syncNow') {
        const symbol = String(params?.symbol || getActiveTradeSymbol() || '').toUpperCase() || null;
        if (!symbol) { rpcOk({ ok: false, reason: 'NO_ACTIVE_SYMBOL' }); return; }
        const live = await leadLagLive.syncNow({ symbol });
        const snap = await getTradeSnapshot(symbol);
        broadcastEvent('trade.positions', { ts: Date.now(), symbol, positions: (snap.positions || []).slice(0, 20) });
        broadcastEvent('trade.orders', { ts: Date.now(), symbol, orders: (snap.orders || []).slice(0, 50) });
        rpcOk({ ok: true, ...live, symbol });
        return;
      }
      if (rpcMethod === 'trade.cancelAll' || rpcMethod === 'trade.panicClose') {
        const mode = tradeExecutor.getExecutionMode();
        if (!['demo', 'real'].includes(mode)) { rpcOk({ ok: false, reason: 'LIVE_MODE_REQUIRED' }); return; }
        if (!tradeExecutor?.enabled?.()) { rpcOk({ ok: false, reason: 'TRADE_DISABLED' }); return; }
        const symbol = String(params?.symbol || getActiveTradeSymbol() || '').toUpperCase() || null;
        if (!symbol) { rpcOk({ ok: false, reason: 'NO_ACTIVE_SYMBOL' }); return; }
        rpcOk({ ok: true });
        Promise.resolve()
          .then(async () => {
            if (rpcMethod === 'trade.panicClose') await tradeExecutor.panicClose({ symbol });
            else await tradeExecutor.cancelAll({ symbol });
          })
          .catch((err) => app.log.warn({ err, method: rpcMethod, symbol }, 'trade emergency action failed'))
          .finally(async () => {
            const snap = await getTradeSnapshot(symbol);
            broadcastEvent('trade.positions', { ts: Date.now(), symbol, positions: (snap.positions || []).slice(0, 20) });
            broadcastEvent('trade.orders', { ts: Date.now(), symbol, orders: (snap.orders || []).slice(0, 50) });
          });
        return;
      }
      if (rpcMethod === 'leadlag.trading.start') {
        const learningParams = leadLagLearning.getActiveParams();
        const settings = { ...(params || {}), leaderSymbol: params?.leader, followerSymbol: params?.follower };
        if (leadLagLearning.getState().autoEnabled) {
          settings.leaderMovePct = Number(learningParams.thresholdPct);
          settings.followerSlPct = Number(learningParams.slPct);
          settings.followerTpPct = Number(learningParams.tpPct);
        }
        const leader = String(settings?.leaderSymbol || 'BTCUSDT').toUpperCase();
        const follower = String(settings?.followerSymbol || 'ETHUSDT').toUpperCase();
        subscriptions.replaceIntent('leadlag-trading', { symbols: [leader, follower], streamType: 'ticker' });
        stopLeadLagSearch({ reason: 'stopped: trading started', preserveRows: false, releaseFeed: true });
        const mode = tradeExecutor.getExecutionMode();
        let result;
        if (mode === 'paper') {
          await leadLagLive.stop({ reason: 'paper-mode-start', closePosition: false });
          result = paperTest.start({ mode: 'paper', settings });
        } else {
          paperTest.stop({ reason: 'live-mode-start' });
          tradeExecutor.setActiveSymbol(follower);
          result = await leadLagLive.start({ settings, executionMode: mode });
          if (!result?.ok) {
            subscriptions.removeIntent('leadlag-trading');
            tradeExecutor.setActiveSymbol(null);
            emitLeadLagState({ force: true, bumpSeq: true });
            rpcOk({ ok: false, reason: result?.reason || 'LIVE_START_FAILED' });
            return;
          }
        }
        rpcOk({ ok: Boolean(result?.ok), reason: result?.reason || null, state: safeLeadLagSnapshot({ bumpSeq: false, where: 'rpc.leadlag.trading.start' }) });
        emitLeadLagState({ force: true, bumpSeq: true });
        return;
      }
      if (rpcMethod === 'leadlag.trading.stop') {
        const mode = tradeExecutor.getExecutionMode();
        if (mode === 'paper') paperTest.stop({ reason: params?.reason || 'manual' });
        else await leadLagLive.stop({ reason: params?.reason || 'manual', closePosition: true });
        subscriptions.removeIntent('leadlag-trading');
        tradeExecutor.setActiveSymbol(null);
        rpcOk({ ok: true, state: safeLeadLagSnapshot({ bumpSeq: false, where: 'rpc.leadlag.trading.stop' }) });
        emitLeadLagState({ force: true, bumpSeq: true });
        return;
      }
      if (rpcMethod === 'leadlag.trading.reset') {
        paperTest.stop({ reason: 'reset' });
        await leadLagLive.stop({ reason: 'reset', closePosition: true });
        subscriptions.removeIntent('leadlag-trading');
        tradeExecutor.setActiveSymbol(null);
        stopLeadLagSearch({ reason: 'stopped: reset', preserveRows: false, releaseFeed: true, silent: true });
        paperTest.reset();
        await leadLagLive.reset();
        rpcOk({ ok: true, state: safeLeadLagSnapshot({ bumpSeq: false, where: 'rpc.leadlag.trading.reset' }) });
        emitLeadLagState({ force: true, bumpSeq: true });
        return;
      }
      if (rpcMethod === 'leadlag.search.startV2') { const result = leadLagSearchV2.start(params || {}); rpcOk({ ok: Boolean(result?.ok), ...(result || {}) }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.stopV2') { const result = leadLagSearchV2.stop(params?.reason || 'stopped'); rpcOk({ ok: Boolean(result?.ok) }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.getStateV2') { rpcOk(leadLagSearchV2.getState()); return; }
      if (rpcMethod === 'leadlag.search.getCombosPage') { rpcOk(leadLagSearchV2.getCombosPage(params || {})); return; }
      if (rpcMethod === 'leadlag.search.getShortlist') { rpcOk(leadLagSearchV2.getShortlist()); return; }
      if (rpcMethod === 'leadlag.learning.getState') { rpcOk(leadLagLearning.getState()); return; }
      if (rpcMethod === 'leadlag.learning.setAuto') { rpcOk(leadLagLearning.setAuto(Boolean(params?.enabled))); return; }
      if (rpcMethod === 'leadlag.learning.syncNow') { const out = await leadLagLearning.syncNow(); rpcOk(out); return; }
      if (rpcMethod === 'leadlag.search.start') { const result = leadLagSearchV2.start(params || {}); rpcOk({ ok: Boolean(result?.ok), ...(result || {}) }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.stop') { leadLagSearchV2.stop('stopped'); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
      if (rpcMethod === 'leadlag.search.reset') { leadLagSearchV2.stop('reset'); leadLagSearchState = createIdleSearchState(); rpcOk({ ok: true }); emitLeadLagState({ force: true, bumpSeq: true }); return; }
    }
    if (!msg?.type) return;
    if (msg.type === "ping") return safeSend(ws, { type: "pong", payload: { now: Date.now() } });
    if (msg.type === 'ui.subscribe' || msg.type === 'ui.unsubscribe') {
      const payload = (msg?.payload && typeof msg.payload === 'object') ? msg.payload : msg;
      const topics = normalizeTopicList(payload?.topics);
      const wsInfo = wsMeta.get(ws);
      if (wsInfo) {
        for (const topic of topics) {
          if (msg.type === 'ui.subscribe') wsInfo.topics.add(topic);
          else wsInfo.topics.delete(topic);
        }
        sendEvent(ws, 'ui.subscriptions', { topics: [...wsInfo.topics] });
      } else {
        sendEvent(ws, 'ui.subscriptions', { topics: [] });
      }
      return;
    }
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
      const full = Boolean(msg?.payload?.full || msg?.full);
      Promise.resolve(getTradeSnapshot()).then((tradeSnap) => safeSend(ws, { type: "snapshot", payload: { ...getSnapshotPayload({ full }), tradePositions: tradeSnap.positions, tradeOrders: tradeSnap.orders } }));
      return;
    }

    if (msg.type === "setSymbols") {
      const maxSymbols = Number(msg.maxSymbols || 100);
      const next = normalizeSymbols(msg.symbols, Math.max(1, Math.min(100, maxSymbols)));
      subscriptions.requestFeed("manual-watchlist", { bybitSymbols: next, streams: ["ticker"] });
      safeSend(ws, { type: "setSymbols.ack", payload: { symbols: next } });
      Promise.resolve(getTradeSnapshot()).then((tradeSnap) => safeSend(ws, { type: "snapshot", payload: { ...getSnapshotPayload({ full: false }), tradePositions: tradeSnap.positions, tradeOrders: tradeSnap.orders } }));
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
      const settings = msg?.settings && typeof msg.settings === "object" ? msg.settings : null;
      const leader = String(settings?.leaderSymbol || "BTCUSDT").toUpperCase();
      const follower = String(settings?.followerSymbol || "ETHUSDT").toUpperCase();
      subscriptions.replaceIntent("leadlag-trading", { symbols: [leader, follower], streamType: 'ticker' });
      stopLeadLagSearch({ reason: 'stopped: trading started', preserveRows: false, releaseFeed: true });
      const result = paperTest.start({ mode: msg.mode || "paper", settings });
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
      const result = leadLagSearchV2.start({});
      safeSend(ws, { type: "leadlag.search.ack", payload: { ok: Boolean(result?.ok), active: Boolean(result?.active), reason: result?.reason || null, state: result?.state || leadLagSearchState } });
      return;
    }
    if (msg.type === "stopLeadLagSearch") {
      const stoppedState = leadLagSearchV2.stop('stopped');
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
      sendLeadLagEventNow(ws, 'leadlag.state', safeLeadLagSnapshot({ bumpSeq: false, where: 'ws.leadlag.state' }));
      safeSend(ws, { type: "paper.state", payload: state });
      return;
    }

    if (msg.type === "refreshUniverse") {
      safeSend(ws, { type: "universe.refresh.ack", payload: { ok: true } });
      universe.refresh().then(() => broadcast({ type: "universe.status", payload: universe.getStatus() }));
      return;
    }


    } catch (err) {
      app.log.error({ err, msgType: msg?.type || null, method: rpcMethod }, 'ws message handling failed');
      if (rpcId !== null && rpcId !== undefined) {
        safeSend(ws, { id: rpcId, error: { code: 'INTERNAL_ERROR', message: String(err?.message || err || 'Internal server error') } });
      } else {
        sendEvent(ws, 'server.error', { message: String(err?.message || err || 'Internal server error'), msgType: msg?.type || null, method: rpcMethod || null, ts: Date.now() });
      }
    }

  });

  ws.on("close", () => { stopStatusWatcher(ws); wsMeta.delete(ws); clients.delete(ws); });
});

await app.listen({ port: PORT, host: HOST });
app.log.info(`server on http://${HOST}:${PORT}`);

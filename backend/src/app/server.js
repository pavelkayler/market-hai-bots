import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

import { ensureDataDir } from '../libraries/config/dataDir.js';
import { createBybitPublicWs } from '../bybitPublicWs.js';
import { createMarketDataStore } from '../marketDataStore.js';
import { createSubscriptionManager } from '../subscriptionManager.js';
import { createBybitRest } from '../bybitRest.js';
import { createBybitPrivateRest } from '../bybitPrivateRest.js';
import { createBybitInstrumentsCache } from '../bybitInstrumentsCache.js';
import { createBybitTradeExecutor } from '../bybitTradeExecutor.js';
import { createMomentumMarketData } from '../services/momentum/momentumMarketData.js';
import { createMomentumSqlite } from '../services/momentum/momentumSqlite.js';
import { createMomentumManager } from '../services/momentum/momentumManager.js';
import { createUniverseSearchService } from '../services/universeSearchService.js';
import { createManualTradeService } from '../services/manual/manualTradeService.js';
import { createMomentumRunsStore } from '../apps/momentum/data-access/momentumRunsStore.js';
import { inspectMomentumSymbol } from '../apps/momentum/domain/inspectMomentum.js';

dotenv.config();
const app = Fastify({ logger: true });
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
ensureDataDir({ logger: app.log });

await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] });
await app.register(websocket);

const clients = new Set();
const wsTopics = new Map();
const send = (ws, payload) => { try { ws.send(JSON.stringify(payload)); } catch {} };
const subscribed = (ws, topic) => {
  const filters = wsTopics.get(ws) || new Set(['*']);
  for (const f of filters) if (f === '*' || f === topic || (f.endsWith('.*') && topic.startsWith(f.slice(0, -1)))) return true;
  return false;
};
const broadcastEvent = (topic, payload) => {
  for (const ws of clients) if (subscribed(ws, topic)) send(ws, { type: 'event', topic, payload });
};

const marketData = createMarketDataStore();
const bybit = createBybitPublicWs({
  symbols: [],
  logger: app.log,
  onStatus: (s) => broadcastEvent('status.bybit', s),
  onTicker: (t) => marketData.upsertTicker({ ...t, source: 'BT' }),
});
const subscriptions = createSubscriptionManager({ bybit, logger: app.log });

const tradeBaseUrl = process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com';
const privateRest = createBybitPrivateRest({ apiKey: process.env.BYBIT_API_KEY, apiSecret: process.env.BYBIT_API_SECRET, baseUrl: tradeBaseUrl, recvWindow: Number(process.env.BYBIT_RECV_WINDOW || 5000) });
const instruments = createBybitInstrumentsCache({ baseUrl: tradeBaseUrl, privateRest, logger: app.log });
const tradeExecutor = createBybitTradeExecutor({ privateRest, instruments, logger: app.log });
const momentumSqlite = createMomentumSqlite({ logger: app.log });
await momentumSqlite.init();
const runsStore = createMomentumRunsStore();
const momentumMarketData = createMomentumMarketData({ logger: app.log });
await momentumMarketData.start();
const bybitRest = createBybitRest({ logger: app.log });
const universeSearch = createUniverseSearchService({ marketData, subscriptions, bybitRest, logger: app.log, emitState: (payload) => broadcastEvent('universeSearch.state', payload), emitResult: (payload) => broadcastEvent('universeSearch.result', payload) });
const momentumManager = createMomentumManager({
  marketData: momentumMarketData,
  sqlite: momentumSqlite,
  tradeExecutor,
  logger: app.log,
  getUniverseBySource: () => [],
  getUniverseTiers: () => universeSearch.getLatestResult?.()?.outputs?.tiers || [],
});
await momentumManager.init();
const manualService = createManualTradeService({ tradeExecutor, marketData: momentumMarketData, logger: app.log });

app.get('/api/health', async () => ({ ok: true }));
app.get('/api/universe-search/state', async () => universeSearch.getState());
app.get('/api/universe-search/result', async () => universeSearch.getLatestResult?.() || { error: 'NOT_FOUND' });
app.post('/api/universe-search/start', async (req) => universeSearch.start(req.body || {}));
app.post('/api/universe-search/stop', async () => universeSearch.stop());
app.get('/api/universe/list', async () => {
  const out = universeSearch.getLatestResult?.();
  const symbols = (out?.outputs?.tiers || []).flatMap((t) => t.symbols || []);
  return { symbols };
});
app.get('/api/momentum/bots/:id/stats', async (req) => runsStore.getStats(String(req.params.id || '')));
app.get('/api/momentum/inspect', async (req, reply) => {
  const symbol = String(req.query?.symbol || '').toUpperCase();
  const botId = String(req.query?.botId || '');
  if (!symbol) return reply.code(400).send({ error: 'SYMBOL_REQUIRED' });
  const state = botId ? momentumManager.getState(botId) : null;
  const config = state?.ok ? (state.stateSnapshot?.config || {}) : {};
  return inspectMomentumSymbol({ symbol, config, marketData: momentumMarketData });
});

app.get('/ws', { websocket: true }, (ws) => {
  clients.add(ws);
  wsTopics.set(ws, new Set(['*']));
  ws.on('close', () => { clients.delete(ws); wsTopics.delete(ws); });
  ws.on('message', async (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;
    if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
    if (msg.type === 'ui.subscribe') {
      const next = new Set((msg.payload?.topics || []).filter((x) => typeof x === 'string'));
      wsTopics.set(ws, next.size ? next : new Set(['*']));
      return;
    }
    if (msg.type === 'ui.unsubscribe') {
      wsTopics.set(ws, new Set(['*']));
      return;
    }
    if (msg.type === 'status.ping') return send(ws, { type: 'event', topic: 'status.pong', payload: { tsEcho: Number(msg.payload?.ts || Date.now()) } });
    if (msg.type === 'status.watch') {
      send(ws, { type: 'event', topic: 'status.health', payload: { now: Date.now(), ws: { connected: true, lastSeenAt: Date.now(), rttMs: 0 }, bybitWs: { status: bybit.getStatus?.().status || 'waiting', lastTickerAt: Date.now(), symbol: 'BTCUSDT' }, cmcApi: { status: 'ok', lastCheckAt: Date.now(), latencyMs: 0 } } });
      return;
    }
    if (!msg.id || !msg.method) return;
    const ok = (result) => send(ws, { id: msg.id, result });
    const p = msg.params || {};
    if (msg.method === 'momentum.list') return ok(momentumManager.list());
    if (msg.method === 'momentum.start') {
      const out = await momentumManager.start(p.config || {});
      if (out?.ok) runsStore.startRun({ botId: out.instanceId, mode: p.config?.mode || 'paper' });
      return ok(out);
    }
    if (msg.method === 'momentum.stop') {
      const out = await momentumManager.stop(p.instanceId);
      const state = momentumManager.getState(p.instanceId);
      runsStore.stopActiveRun({ botId: p.instanceId, summary: state?.stateSnapshot?.stats || {} });
      return ok(out);
    }
    if (msg.method === 'momentum.continue') {
      const out = await momentumManager.continue(p.instanceId);
      if (out?.ok) runsStore.startRun({ botId: p.instanceId, mode: out?.stateSnapshot?.config?.mode || 'paper' });
      return ok(out);
    }
    if (msg.method === 'momentum.deleteInstance') {
      const out = await momentumManager.deleteInstance(p.instanceId);
      runsStore.deleteBot(p.instanceId);
      return ok(out);
    }
    if (msg.method === 'momentum.getInstanceState') return ok(momentumManager.getState(p.instanceId));
    if (msg.method === 'momentum.getTrades') return ok(await momentumManager.getTrades(p.instanceId, p.limit, p.offset));
    if (msg.method === 'momentum.getSignals') return ok(await momentumManager.getSignals(p.instanceId, Math.min(3, Number(p.limit) || 3)));
    if (msg.method === 'momentum.getFixedSignals') return ok(await momentumManager.getFixedSignals(p.instanceId, p.limit, p.sinceMs, p.symbol));
    if (msg.method === 'momentum.updateInstanceConfig') return ok(await momentumManager.updateInstanceConfig(p.instanceId, p.patch || {}));
    if (msg.method === 'manual.placeDemoOrder') return ok(await manualService.placeDemoOrder(p || {}));
    if (msg.method === 'manual.getDemoState') return ok(await manualService.getDemoState(p || {}));
    if (msg.method === 'manual.getQuote') return ok(await manualService.getQuote(p || {}));
    if (msg.method === 'manual.closeDemoPosition') return ok(await manualService.closeDemoPosition(p || {}));
    if (msg.method === 'manual.cancelDemoOrders') return ok(await manualService.cancelDemoOrders(p || {}));
    return ok({ ok: false, reason: 'UNKNOWN_METHOD' });
  });
});

setInterval(() => {
  momentumManager.list?.().instances?.forEach?.(() => {});
  broadcastEvent('bots.overview', {
    paperBalance: 10000,
    bots: (momentumManager.list?.().instances || []).map((i) => ({ name: i.id, status: i.status, pnl: i.pnlNetTotal || 0, startedAt: i.startedAt })),
  });
}, 1500);

await app.listen({ host: HOST, port: PORT });

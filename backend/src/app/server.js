import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

import { ensureDataDir } from '../libraries/config/dataDir.js';
import { createBybitInstrumentsCache, createBybitPrivateRest, createBybitPublicWs, createBybitRest, createBybitTradeExecutor } from '../libraries/bybit/index.js';
import { createMarketDataStore, createSubscriptionManager } from '../libraries/market-data/index.js';
import { createMomentumApp } from '../apps/momentum/index.js';
import { createUniverseApp } from '../apps/universe/index.js';
import { createManualApp } from '../apps/manual/index.js';
import { createMomentumRunsStore } from '../apps/momentum/data-access/momentumRunsStore.js';
import { registerStatusRoutes } from '../apps/status/api/registerStatusRoutes.js';
import { registerUniverseRoutes } from '../apps/universe/api/registerUniverseRoutes.js';
import { registerMomentumRoutes } from '../apps/momentum/api/registerMomentumRoutes.js';
import { registerManualRoutes } from '../apps/manual/api/registerManualRoutes.js';
import { createWsBroadcast } from '../libraries/ws/broadcast.js';
import { createRpcRouter } from './ws/rpcRouter.js';

dotenv.config();
const app = Fastify({ logger: true });
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
ensureDataDir({ logger: app.log });

await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] });
await app.register(websocket);

const wsBroadcast = createWsBroadcast();

const marketData = createMarketDataStore();
const bybit = createBybitPublicWs({
  symbols: [],
  logger: app.log,
  onStatus: (s) => wsBroadcast.broadcastEvent('status.bybit', s),
  onTicker: (t) => marketData.upsertTicker({ ...t, source: 'BT' }),
});
const subscriptions = createSubscriptionManager({ bybit, logger: app.log });

const tradeBaseUrl = process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com';
const privateRest = createBybitPrivateRest({ apiKey: process.env.BYBIT_API_KEY, apiSecret: process.env.BYBIT_API_SECRET, baseUrl: tradeBaseUrl, recvWindow: Number(process.env.BYBIT_RECV_WINDOW || 5000) });
const instruments = createBybitInstrumentsCache({ baseUrl: tradeBaseUrl, privateRest, logger: app.log });
const tradeExecutor = createBybitTradeExecutor({ privateRest, instruments, logger: app.log });
const runsStore = createMomentumRunsStore();
const bybitRest = createBybitRest({ logger: app.log });
const universeApp = createUniverseApp({ marketData, subscriptions, bybitRest, logger: app.log, emitState: (payload) => wsBroadcast.broadcastEvent('universeSearch.state', payload), emitResult: (payload) => wsBroadcast.broadcastEvent('universeSearch.result', payload) });
const universeSearch = universeApp.service;
const momentumApp = await createMomentumApp({ logger: app.log, tradeExecutor, getUniverseTiers: () => universeSearch.getLatestResult?.()?.outputs?.tiers || [] });
const momentumManager = momentumApp.manager;
const momentumMarketData = momentumApp.marketData;
const manualApp = createManualApp({ tradeExecutor, marketData: momentumMarketData, logger: app.log });
const manualService = manualApp.service;

const getStatusPayload = () => {
  const bybitStatus = momentumMarketData.getStatus?.() || {};
  const now = Date.now();
  const lastTickTs = Number(bybitStatus.lastTickTs || 0);
  return {
    now,
    ws: { connected: true, lastSeenAt: now, rttMs: 0 },
    bybitWs: {
      wsConnected: Boolean(bybitStatus.wsConnected),
      subscribedCount: Number(bybitStatus.subscribedCount || 0),
      lastTickTs,
      lastTickAgeSec: lastTickTs > 0 ? Math.max(0, Math.floor((now - lastTickTs) / 1000)) : null,
      snapshotAgeSec: bybitStatus.snapshotAgeSec,
      activeIntervals: bybitStatus.activeIntervals || [],
      tickersSnapshotCount: bybitStatus.tickersSnapshotCount || 0,
    },
  };
};

registerStatusRoutes(app, { momentumMarketData });
registerUniverseRoutes(app, { universeSearch });
registerMomentumRoutes(app, { runsStore, momentumManager, momentumMarketData });
registerManualRoutes(app, { manualService });
app.get('/api/health', async () => ({ ok: true }));

const rpcRouter = createRpcRouter({ momentumManager, runsStore, manualService, send: wsBroadcast.send, getStatusPayload });

app.get('/ws', { websocket: true }, (ws) => {
  wsBroadcast.onOpen(ws);
  ws.on('close', () => wsBroadcast.onClose(ws));
  ws.on('message', async (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;
    if (msg.type === 'ping') return wsBroadcast.send(ws, { type: 'pong', ts: Date.now() });
    if (msg.type === 'ui.subscribe') return wsBroadcast.subscribeTopics(ws, msg.payload?.topics || []);
    if (msg.type === 'ui.unsubscribe') return wsBroadcast.resetTopics(ws);
    await rpcRouter.handleRpcMessage(ws, msg);
  });
});

setInterval(() => {
  wsBroadcast.broadcastEvent('bots.overview', {
    paperBalance: 10000,
    bots: (momentumManager.list?.().instances || []).map((i) => ({ name: i.id, status: i.status, pnl: i.pnlNetTotal || 0, startedAt: i.startedAt })),
  });
}, 1500);

await app.listen({ host: HOST, port: PORT });

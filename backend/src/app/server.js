import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

import { ensureDataDir } from '../libraries/config/dataDir.js';
import { createBybitInstrumentsCache, createBybitPrivateRest, createBybitPublicWs, createBybitRest, createBybitTradeExecutor } from '../libraries/bybit/index.js';
import { createMarketDataStore, createSubscriptionManager } from '../libraries/market-data/index.js';
import { createWsBroadcaster } from '../libraries/ws/broadcast.js';
import { createMomentumApp } from '../apps/momentum/index.js';
import { createUniverseApp } from '../apps/universe/index.js';
import { createManualApp } from '../apps/manual/index.js';
import { createMomentumRunsStore } from '../apps/momentum/data-access/momentumRunsStore.js';
import { registerStatusRoutes } from '../apps/status/api/registerStatusRoutes.js';
import { registerUniverseRoutes } from '../apps/universe/api/registerUniverseRoutes.js';
import { registerMomentumRoutes } from '../apps/momentum/api/registerMomentumRoutes.js';
import { registerManualRoutes } from '../apps/manual/api/registerManualRoutes.js';
import { createRpcRouter } from './ws/rpcRouter.js';

dotenv.config();
const app = Fastify({ logger: true });
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
ensureDataDir({ logger: app.log });

await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] });
await app.register(websocket);

const broadcaster = createWsBroadcaster();
const marketData = createMarketDataStore();
const bybit = createBybitPublicWs({
  symbols: [],
  logger: app.log,
  onStatus: (s) => broadcaster.broadcastEvent('status.bybit', s),
  onTicker: (t) => marketData.upsertTicker({ ...t, source: 'BT' }),
});
const subscriptions = createSubscriptionManager({ bybit, logger: app.log });

const tradeBaseUrl = process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com';
const privateRest = createBybitPrivateRest({ apiKey: process.env.BYBIT_API_KEY, apiSecret: process.env.BYBIT_API_SECRET, baseUrl: tradeBaseUrl, recvWindow: Number(process.env.BYBIT_RECV_WINDOW || 5000) });
const instruments = createBybitInstrumentsCache({ baseUrl: tradeBaseUrl, privateRest, logger: app.log });
const tradeExecutor = createBybitTradeExecutor({ privateRest, instruments, logger: app.log });
const runsStore = createMomentumRunsStore();
const bybitRest = createBybitRest({ logger: app.log });

const universeApp = createUniverseApp({
  marketData,
  subscriptions,
  bybitRest,
  logger: app.log,
  emitState: (payload) => broadcaster.broadcastEvent('universeSearch.state', payload),
  emitResult: (payload) => broadcaster.broadcastEvent('universeSearch.result', payload),
});
const universeSearch = universeApp.service;

const momentumApp = await createMomentumApp({ logger: app.log, tradeExecutor, getUniverseTiers: () => universeSearch.getLatestResult?.()?.outputs?.tiers || [] });
const momentumManager = momentumApp.manager;
const momentumMarketData = momentumApp.marketData;
const manualApp = createManualApp({ tradeExecutor, marketData: momentumMarketData, logger: app.log });
const manualService = manualApp.service;

app.get('/api/health', async () => ({ ok: true }));
registerStatusRoutes(app, { momentumMarketData });
registerUniverseRoutes(app, { universeSearch });
registerMomentumRoutes(app, { runsStore, momentumManager, momentumMarketData });
registerManualRoutes(app, { manualService });

const rpcRouter = createRpcRouter({ broadcaster, bybit, momentumManager, runsStore, manualService, momentumMarketData });

app.get('/ws', { websocket: true }, (ws) => {
  broadcaster.addClient(ws);
  ws.on('close', () => broadcaster.removeClient(ws));
  ws.on('message', async (raw) => {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg) return;
    await rpcRouter.handleRpcMessage(ws, msg);
  });
});

setInterval(() => {
  broadcaster.broadcastEvent('bots.overview', {
    paperBalance: 10000,
    bots: (momentumManager.list?.().instances || []).map((i) => ({ name: i.id, status: i.status, pnl: i.pnlNetTotal || 0, startedAt: i.startedAt })),
  });
}, 1500);

await app.listen({ host: HOST, port: PORT });

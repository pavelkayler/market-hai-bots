import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { MarketHub } from './market/marketHub.js';
import type { TickerStream } from './market/tickerStream.js';
import { BybitMarketClient, type IBybitMarketClient } from './services/bybitMarketClient.js';
import { ActiveSymbolSet, UniverseService } from './services/universeService.js';
import { SymbolUpdateBroadcaster } from './ws/symbolUpdateBroadcaster.js';

type BuildServerOptions = {
  marketClient?: IBybitMarketClient;
  universeFilePath?: string;
  activeSymbolSet?: ActiveSymbolSet;
  tickerStream?: TickerStream;
};


const botStateResponse = {
  running: false,
  mode: null,
  direction: null,
  tf: null,
  queueDepth: 0,
  activeOrders: 0,
  openPositions: 0
};

const marketHubByApp = new WeakMap<FastifyInstance, MarketHub>();

export function getMarketHub(app: FastifyInstance): MarketHub {
  const marketHub = marketHubByApp.get(app);
  if (!marketHub) {
    throw new Error('MarketHub is not registered for this app instance');
  }

  return marketHub;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  const marketClient = options.marketClient ?? new BybitMarketClient();
  const activeSymbolSet = options.activeSymbolSet ?? new ActiveSymbolSet();
  const universeService = new UniverseService(marketClient, activeSymbolSet, app.log, options.universeFilePath);
  const wsClients = new Set<{ send: (payload: string) => unknown }>();
  const symbolUpdateBroadcaster = new SymbolUpdateBroadcaster(wsClients, 500);

  const marketHub = new MarketHub({
    tickerStream: options.tickerStream,
    onMarketStateUpdate: (symbol, state) => {
      symbolUpdateBroadcaster.broadcast(symbol, state);
    }
  });
  marketHubByApp.set(app, marketHub);

  const broadcast = (type: string, payload: Record<string, unknown>): void => {
    const message = JSON.stringify({ type, ts: Date.now(), payload });
    for (const client of wsClients) {
      client.send(message);
    }
  };

  app.register(cors, { origin: true });
  app.register(websocket);

  app.get('/health', async () => {
    return { ok: true };
  });

  app.get('/api/bot/state', async () => {
    return botStateResponse;
  });

  app.post('/api/universe/create', async (request, reply) => {
    const body = request.body as { minVolPct?: unknown };

    if (typeof body?.minVolPct !== 'number' || !Number.isFinite(body.minVolPct)) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_VOL_PCT' });
    }

    const result = await universeService.create(body.minVolPct);
    await marketHub.setUniverseSymbols(result.state.symbols.map((entry) => entry.symbol));
    const response = {
      ok: true,
      createdAt: result.state.createdAt,
      filters: result.state.filters,
      totalFetched: result.totalFetched,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive
    };

    broadcast('universe:created', {
      filters: response.filters,
      passed: response.passed,
      forcedActive: response.forcedActive
    });

    return response;
  });

  app.post('/api/universe/refresh', async (request, reply) => {
    const body = request.body as { minVolPct?: unknown } | undefined;

    if (body?.minVolPct !== undefined && (typeof body.minVolPct !== 'number' || !Number.isFinite(body.minVolPct))) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_VOL_PCT' });
    }

    const result = await universeService.refresh(body?.minVolPct);
    if (!result) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    await marketHub.setUniverseSymbols(result.state.symbols.map((entry) => entry.symbol));

    const response = {
      ok: true,
      refreshedAt: result.state.createdAt,
      filters: result.state.filters,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive
    };

    broadcast('universe:refreshed', {
      filters: response.filters,
      passed: response.passed,
      forcedActive: response.forcedActive
    });

    return response;
  });

  app.get('/api/universe', async () => {
    const state = await universeService.get();
    if (!state) {
      return { ok: false, ready: false };
    }

    return {
      ok: true,
      ...state
    };
  });

  app.post('/api/universe/clear', async () => {
    await universeService.clear();
    await marketHub.setUniverseSymbols([]);
    symbolUpdateBroadcaster.reset();
    return { ok: true };
  });

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
      wsClients.add(socket as { send: (payload: string) => unknown });
      socket.on('close', () => {
        wsClients.delete(socket as { send: (payload: string) => unknown });
      });

      socket.send(
        JSON.stringify({
          type: 'state',
          ts: Date.now(),
          payload: {
            universeReady: false,
            running: false,
            mode: null,
            queueDepth: 0
          }
        })
      );
    });
  });

  app.addHook('onClose', async () => {
    await marketHub.stop();
  });

  return app;
}

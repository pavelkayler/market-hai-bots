import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { BybitMarketClient, type IBybitMarketClient } from './services/bybitMarketClient.js';
import { ActiveSymbolSet, UniverseService } from './services/universeService.js';

type BuildServerOptions = {
  marketClient?: IBybitMarketClient;
  universeFilePath?: string;
  activeSymbolSet?: ActiveSymbolSet;
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

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  const marketClient = options.marketClient ?? new BybitMarketClient();
  const activeSymbolSet = options.activeSymbolSet ?? new ActiveSymbolSet();
  const universeService = new UniverseService(marketClient, activeSymbolSet, app.log, options.universeFilePath);
  const wsClients = new Set<{ send: (payload: string) => unknown }>();

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

  return app;
}

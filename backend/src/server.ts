import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { BotEngine, normalizeBotConfig } from './bot/botEngine.js';
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
  now?: () => number;
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

  const broadcast = (type: string, payload: Record<string, unknown>): void => {
    const message = JSON.stringify({ type, ts: Date.now(), payload });
    for (const client of wsClients) {
      client.send(message);
    }
  };

  const botEngine = new BotEngine({
    now: options.now,
    emitSignal: (payload) => {
      broadcast('signal:new', payload);
    },
    emitOrderUpdate: (payload) => {
      broadcast('order:update', payload);
    },
    emitPositionUpdate: (payload) => {
      broadcast('position:update', payload);
    }
  });

  const marketHub = new MarketHub({
    tickerStream: options.tickerStream,
    onMarketStateUpdate: (symbol, state) => {
      botEngine.onMarketUpdate(symbol, state);
      const symbolState = botEngine.getSymbolState(symbol);
      if (!symbolState) {
        return;
      }

      symbolUpdateBroadcaster.broadcast(
        symbol,
        state,
        symbolState.fsmState,
        symbolState.baseline,
        symbolState.pendingOrder,
        symbolState.position
      );
    }
  });
  marketHubByApp.set(app, marketHub);

  app.register(cors, { origin: true });
  app.register(websocket);

  app.get('/health', async () => {
    return { ok: true };
  });

  app.post('/api/bot/start', async (request, reply) => {
    const universe = await universeService.get();
    if (!universe?.ready || universe.symbols.length === 0) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    if (!marketHub.isRunning()) {
      return reply.code(400).send({ ok: false, error: 'MARKET_HUB_NOT_RUNNING' });
    }

    const config = normalizeBotConfig((request.body as Record<string, unknown>) ?? {});
    if (!config) {
      return reply.code(400).send({ ok: false, error: 'INVALID_BOT_CONFIG' });
    }

    botEngine.setUniverseSymbols(universe.symbols.map((entry) => entry.symbol));
    botEngine.start(config);

    return { ok: true, ...botEngine.getState() };
  });

  app.post('/api/bot/stop', async () => {
    botEngine.stop();
    return { ok: true, ...botEngine.getState() };
  });

  app.get('/api/bot/state', async () => {
    const state = botEngine.getState();
    return {
      running: state.running,
      mode: state.config?.mode ?? null,
      direction: state.config?.direction ?? null,
      tf: state.config?.tf ?? null,
      queueDepth: state.queueDepth,
      activeOrders: state.activeOrders,
      openPositions: state.openPositions,
      startedAt: state.startedAt
    };
  });

  app.post('/api/orders/cancel', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    if (typeof body?.symbol !== 'string' || body.symbol.length === 0) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const marketState = marketHub.getState(body.symbol);
    if (!marketState) {
      return { ok: true };
    }

    botEngine.cancelPendingOrder(body.symbol, marketState);
    return { ok: true };
  });

  app.post('/api/universe/create', async (request, reply) => {
    const body = request.body as { minVolPct?: unknown };

    if (typeof body?.minVolPct !== 'number' || !Number.isFinite(body.minVolPct)) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_VOL_PCT' });
    }

    const result = await universeService.create(body.minVolPct);
    const symbols = result.state.symbols.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseSymbols(symbols);
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

    const symbols = result.state.symbols.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseSymbols(symbols);

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
    botEngine.setUniverseSymbols([]);
    symbolUpdateBroadcaster.reset();
    return { ok: true };
  });

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
      wsClients.add(socket as { send: (payload: string) => unknown });
      socket.on('close', () => {
        wsClients.delete(socket as { send: (payload: string) => unknown });
      });

      const state = botEngine.getState();
      socket.send(
        JSON.stringify({
          type: 'state',
          ts: Date.now(),
          payload: {
            universeReady: false,
            running: state.running,
            mode: state.config?.mode ?? null,
            queueDepth: state.queueDepth
          }
        })
      );
    });
  });

  app.addHook('onReady', async () => {
    await marketHub.start();
  });

  app.addHook('onClose', async () => {
    await marketHub.stop();
  });

  return app;
}

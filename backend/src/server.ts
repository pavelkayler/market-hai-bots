import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

const botStateResponse = {
  running: false,
  mode: null,
  direction: null,
  tf: null,
  queueDepth: 0,
  activeOrders: 0,
  openPositions: 0
};

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });
  app.register(websocket);

  app.get('/health', async () => {
    return { ok: true };
  });

  app.get('/api/bot/state', async () => {
    return botStateResponse;
  });

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
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

import { inspectMomentumSymbol } from '../domain/inspectMomentum.js';

export function registerMomentumRoutes(app, { runsStore, momentumManager, momentumMarketData }) {
  app.get('/api/momentum/bots/:id/stats', async (req) => runsStore.getStats(String(req.params.id || '')));
  app.get('/api/momentum/inspect', async (req, reply) => {
    const symbol = String(req.query?.symbol || '').toUpperCase();
    const botId = String(req.query?.botId || '');
    if (!symbol) return reply.code(400).send({ error: 'SYMBOL_REQUIRED' });
    const state = botId ? momentumManager.getState(botId) : null;
    const config = state?.ok ? (state.stateSnapshot?.config || {}) : {};
    return inspectMomentumSymbol({ symbol, config, marketData: momentumMarketData });
  });
}

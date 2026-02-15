export function registerUniverseRoutes(app, { universeSearch }) {
  app.get('/api/universe-search/state', async () => universeSearch.getState());
  app.get('/api/universe-search/result', async () => universeSearch.getLatestResult?.() || { error: 'NOT_FOUND' });
  app.post('/api/universe-search/start', async (req) => universeSearch.start(req.body || {}));
  app.post('/api/universe-search/stop', async () => universeSearch.stop());
  app.get('/api/universe/list', async () => {
    const out = universeSearch.getLatestResult?.();
    const symbols = (out?.outputs?.tiers || []).flatMap((tier) => tier.symbols || []);
    return { symbols };
  });
}

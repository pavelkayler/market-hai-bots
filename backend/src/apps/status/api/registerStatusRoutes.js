export function registerStatusRoutes(app, deps) {
  const { momentumMarketData } = deps;

  app.get('/api/status/watch', async () => {
    const bybit = momentumMarketData.getStatus?.() || {};
    const lastTickTs = Number(bybit.lastTickTs || 0);
    return {
      now: Date.now(),
      bybit: {
        ...bybit,
        lastTickAgeSec: lastTickTs > 0 ? Math.max(0, Math.floor((Date.now() - lastTickTs) / 1000)) : null,
      },
    };
  });
}

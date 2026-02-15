function withAgeSec(ts) {
  if (!(Number(ts) > 0)) return null;
  return Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
}

export function buildBybitStatus(momentumMarketData) {
  const status = momentumMarketData?.getStatus?.() || {};
  return {
    wsConnected: Boolean(status.wsConnected),
    subscribedCount: Number(status.subscribedCount || 0),
    lastTickTs: Number(status.lastTickTs || 0) || null,
    lastTickAgeSec: withAgeSec(status.lastTickTs),
    snapshotAgeSec: Number.isFinite(Number(status.snapshotAgeSec)) ? Number(status.snapshotAgeSec) : null,
    activeIntervals: Array.isArray(status.activeIntervals) ? status.activeIntervals : [],
    tickersSnapshotCount: Number(status.tickersSnapshotCount || 0),
  };
}

export function registerStatusRoutes(app, { momentumMarketData }) {
  app.get('/api/status/watch', async () => ({ bybit: buildBybitStatus(momentumMarketData) }));
}

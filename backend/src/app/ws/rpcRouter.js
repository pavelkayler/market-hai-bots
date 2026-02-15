import { buildBybitStatus } from '../../apps/status/api/registerStatusRoutes.js';

export function createRpcRouter({ broadcaster, bybit, momentumManager, runsStore, manualService, momentumMarketData }) {
  return {
    async handleRpcMessage(ws, msg) {
      const send = broadcaster.send;
      if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Date.now() });
      if (msg.type === 'ui.subscribe') return broadcaster.subscribe(ws, msg.payload?.topics || []);
      if (msg.type === 'ui.unsubscribe') return broadcaster.unsubscribe(ws);
      if (msg.type === 'status.ping') return send(ws, { type: 'event', topic: 'status.pong', payload: { tsEcho: Number(msg.payload?.ts || Date.now()) } });
      if (msg.type === 'status.watch') {
        return send(ws, {
          type: 'event',
          topic: 'status.health',
          payload: {
            now: Date.now(),
            ws: { connected: true, lastSeenAt: Date.now(), rttMs: 0 },
            bybit: buildBybitStatus(momentumMarketData),
            bybitWs: { status: bybit.getStatus?.().status || 'waiting' },
          },
        });
      }
      if (!msg.id || !msg.method) return null;
      const ok = (result) => send(ws, { id: msg.id, result });
      const p = msg.params || {};

      if (msg.method === 'momentum.list') return ok(momentumManager.list());
      if (msg.method === 'momentum.start') {
        const out = await momentumManager.start(p.config || {});
        if (out?.ok) runsStore.startRun({ botId: out.instanceId, mode: out?.stateSnapshot?.config?.mode || p.config?.mode || 'paper' });
        return ok(out);
      }
      if (msg.method === 'momentum.stop') {
        const out = await momentumManager.stop(p.instanceId);
        const state = momentumManager.getState(p.instanceId);
        runsStore.stopActiveRun({ botId: p.instanceId, summary: state?.stateSnapshot?.stats || {} });
        return ok(out);
      }
      if (msg.method === 'momentum.continue') {
        const out = await momentumManager.continue(p.instanceId);
        if (out?.ok) runsStore.startRun({ botId: p.instanceId, mode: out?.stateSnapshot?.config?.mode || 'paper' });
        return ok(out);
      }
      if (msg.method === 'momentum.deleteInstance') {
        const out = await momentumManager.deleteInstance(p.instanceId);
        runsStore.deleteBot(p.instanceId);
        return ok(out);
      }
      if (msg.method === 'momentum.getInstanceState') return ok(momentumManager.getState(p.instanceId));
      if (msg.method === 'momentum.getTrades') return ok(await momentumManager.getTrades(p.instanceId, p.limit, p.offset));
      if (msg.method === 'momentum.getSignals') return ok(await momentumManager.getSignals(p.instanceId, Math.min(3, Number(p.limit) || 3)));
      if (msg.method === 'momentum.getFixedSignals') return ok(await momentumManager.getFixedSignals(p.instanceId, p.limit, p.sinceMs, p.symbol));
      if (msg.method === 'momentum.updateInstanceConfig') return ok(await momentumManager.updateInstanceConfig(p.instanceId, p.patch || {}));
      if (msg.method === 'manual.placeDemoOrder') return ok(await manualService.placeDemoOrder(p || {}));
      if (msg.method === 'manual.getDemoState') return ok(await manualService.getDemoState(p || {}));
      if (msg.method === 'manual.getQuote') return ok(await manualService.getQuote(p || {}));
      if (msg.method === 'manual.closeDemoPosition') return ok(await manualService.closeDemoPosition(p || {}));
      if (msg.method === 'manual.cancelDemoOrders') return ok(await manualService.cancelDemoOrders(p || {}));
      return ok({ ok: false, reason: 'UNKNOWN_METHOD' });
    },
  };
}

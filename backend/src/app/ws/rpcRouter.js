export function createRpcRouter(deps) {
  const { momentumManager, runsStore, manualService, send, getStatusPayload } = deps;

  function ok(ws, id, result) {
    send(ws, { id, result });
  }

  return {
    async handleRpcMessage(ws, msg) {
      if (!msg) return;
      if (msg.type === 'status.ping') {
        send(ws, { type: 'event', topic: 'status.pong', payload: { tsEcho: Number(msg.payload?.ts || Date.now()) } });
        return;
      }
      if (msg.type === 'status.watch') {
        send(ws, { type: 'event', topic: 'status.health', payload: getStatusPayload() });
        return;
      }
      if (!msg.id || !msg.method) return;
      const p = msg.params || {};
      if (msg.method === 'momentum.list') return ok(ws, msg.id, momentumManager.list());
      if (msg.method === 'momentum.start') {
        const out = await momentumManager.start(p.config || {});
        if (out?.ok) runsStore.startRun({ botId: out.instanceId, mode: out?.stateSnapshot?.config?.mode || 'paper' });
        return ok(ws, msg.id, out);
      }
      if (msg.method === 'momentum.stop') {
        const out = await momentumManager.stop(p.instanceId);
        const state = momentumManager.getState(p.instanceId);
        runsStore.stopActiveRun({ botId: p.instanceId, summary: state?.stateSnapshot?.stats || {} });
        return ok(ws, msg.id, out);
      }
      if (msg.method === 'momentum.continue') {
        const out = await momentumManager.continue(p.instanceId);
        if (out?.ok) runsStore.startRun({ botId: p.instanceId, mode: out?.stateSnapshot?.config?.mode || 'paper' });
        return ok(ws, msg.id, out);
      }
      if (msg.method === 'momentum.deleteInstance') {
        const out = await momentumManager.deleteInstance(p.instanceId);
        runsStore.deleteBot(p.instanceId);
        return ok(ws, msg.id, out);
      }
      if (msg.method === 'momentum.getInstanceState') return ok(ws, msg.id, momentumManager.getState(p.instanceId));
      if (msg.method === 'momentum.getTrades') return ok(ws, msg.id, await momentumManager.getTrades(p.instanceId, p.limit, p.offset));
      if (msg.method === 'momentum.getSignals') return ok(ws, msg.id, await momentumManager.getSignals(p.instanceId, Math.min(3, Number(p.limit) || 3)));
      if (msg.method === 'momentum.getFixedSignals') return ok(ws, msg.id, await momentumManager.getFixedSignals(p.instanceId, p.limit, p.sinceMs, p.symbol));
      if (msg.method === 'momentum.updateInstanceConfig') return ok(ws, msg.id, await momentumManager.updateInstanceConfig(p.instanceId, p.patch || {}));
      if (msg.method === 'manual.placeDemoOrder') return ok(ws, msg.id, await manualService.placeDemoOrder(p || {}));
      if (msg.method === 'manual.getDemoState') return ok(ws, msg.id, await manualService.getDemoState(p || {}));
      if (msg.method === 'manual.getQuote') return ok(ws, msg.id, await manualService.getQuote(p || {}));
      if (msg.method === 'manual.closeDemoPosition') return ok(ws, msg.id, await manualService.closeDemoPosition(p || {}));
      if (msg.method === 'manual.cancelDemoOrders') return ok(ws, msg.id, await manualService.cancelDemoOrders(p || {}));
      return ok(ws, msg.id, { ok: false, reason: 'UNKNOWN_METHOD' });
    },
  };
}

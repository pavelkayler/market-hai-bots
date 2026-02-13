import { EventEmitter } from 'events';
import { createMomentumInstance } from './momentumInstance.js';

export function createMomentumManager({ marketData, sqlite, logger = console }) {
  const emitter = new EventEmitter();
  const instances = new Map();

  function emitState() {
    emitter.emit('state', { market: marketData.getStatus(), instances: [...instances.values()].map((x) => x.getLight()) });
  }

  marketData.onTick((tick) => {
    const eligible = marketData.getEligibleSymbols();
    for (const inst of instances.values()) inst.onTick(tick, eligible);
    emitState();
  });

  function start(config) {
    const id = `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const inst = createMomentumInstance({ id, config, marketData, sqlite, logger });
    instances.set(id, inst);
    emitState();
    return { ok: true, instanceId: id, stateSnapshot: inst.getSnapshot() };
  }

  function stop(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    inst.stop();
    instances.delete(instanceId);
    emitState();
    return { ok: true };
  }

  return {
    start,
    stop,
    list: () => ({ ok: true, instances: [...instances.values()].map((x) => x.getLight()) }),
    getState: (instanceId) => {
      const inst = instances.get(instanceId);
      if (!inst) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, stateSnapshot: inst.getSnapshot() };
    },
    getPositions: (instanceId) => {
      const inst = instances.get(instanceId);
      if (!inst) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, positions: inst.getSnapshot().openPositions };
    },
    getTrades: async (instanceId, limit, offset) => ({ ok: true, ...(await sqlite.getTrades(instanceId, limit, offset)) }),
    getMarketStatus: () => ({ ok: true, ...marketData.getStatus() }),
    onState: (fn) => emitter.on('state', fn),
  };
}

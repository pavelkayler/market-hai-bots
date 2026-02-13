import { EventEmitter } from 'events';
import { createMomentumInstance } from './momentumInstance.js';

export function createMomentumManager({ marketData, sqlite, logger = console }) {
  const emitter = new EventEmitter();
  const instances = new Map();

  function emitState() {
    emitter.emit('state', { market: marketData.getStatus(), instances: [...instances.values()].map((x) => x.getLight()) });
  }

  function syncActiveIntervals() {
    const intervals = [...instances.values()].map((x) => Number(x.getLight().windowMinutes));
    marketData.setActiveIntervals?.(intervals);
  }

  marketData.onTick((tick) => {
    const eligible = marketData.getEligibleSymbols();
    for (const inst of instances.values()) inst.onTick(tick, eligible);
    emitState();
  });

  function start(config) {
    const id = `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const windowMinutes = Number(config?.windowMinutes);
    if (![1, 3, 5].includes(windowMinutes)) {
      return { ok: false, error: 'INVALID_WINDOW_MINUTES', message: 'windowMinutes must be 1, 3, or 5' };
    }
    const inst = createMomentumInstance({ id, config, marketData, sqlite, logger });
    instances.set(id, inst);
    syncActiveIntervals();
    emitState();
    return { ok: true, instanceId: id, stateSnapshot: inst.getSnapshot() };
  }

  function stop(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    inst.stop();
    instances.delete(instanceId);
    syncActiveIntervals();
    emitState();
    return { ok: true };
  }

  function cancelEntry(instanceId, symbol) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    return inst.cancelEntry(symbol, { ts: Date.now(), outcome: 'MANUAL_CANCEL', logMessage: 'manual cancel entry' });
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
    cancelEntry,
    onState: (fn) => emitter.on('state', fn),
  };
}

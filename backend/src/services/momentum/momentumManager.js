import { EventEmitter } from 'events';
import { createMomentumInstance } from './momentumInstance.js';

export function createMomentumManager({ marketData, sqlite, tradeExecutor = null, logger = console }) {
  const emitter = new EventEmitter();
  const instances = new Map();

  function withPreflight(light) {
    const pre = tradeExecutor?.getPreflightStatus?.() || {};
    return {
      ...light,
      marginMode: pre.marginMode || 'UNKNOWN',
      lastMarginModeCheckTs: pre.lastMarginModeCheckTs || null,
      lastMarginModeError: pre.lastMarginModeError || null,
      hedgeMode: pre.hedgeMode || 'UNKNOWN',
      lastHedgeModeCheckTs: pre.lastHedgeModeCheckTs || null,
      lastHedgeModeError: pre.lastHedgeModeError || null,
    };
  }

  function getMarketStatus() {
    const base = marketData.getStatus();
    const pre = tradeExecutor?.getPreflightStatus?.() || {};
    return {
      ...base,
      marginMode: pre.marginMode || 'UNKNOWN',
      lastMarginModeCheckTs: pre.lastMarginModeCheckTs || null,
      lastMarginModeError: pre.lastMarginModeError || null,
      hedgeMode: pre.hedgeMode || 'UNKNOWN',
      lastHedgeModeCheckTs: pre.lastHedgeModeCheckTs || null,
      lastHedgeModeError: pre.lastHedgeModeError || null,
    };
  }

  function emitState() {
    emitter.emit('state', { market: getMarketStatus(), instances: [...instances.values()].map((x) => withPreflight(x.getLight())) });
  }

  function syncActiveIntervals() {
    const intervals = [...instances.values()].map((x) => Number(x.getLight().windowMinutes));
    marketData.setActiveIntervals?.(intervals);
  }

  marketData.onTick(async (tick) => {
    const eligible = marketData.getEligibleSymbols();
    for (const inst of instances.values()) await inst.onTick(tick, eligible);
    emitState();
  });

  async function start(config) {
    const id = `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const windowMinutes = Number(config?.windowMinutes);
    if (![1, 3, 5].includes(windowMinutes)) {
      return { ok: false, error: 'INVALID_WINDOW_MINUTES', message: 'windowMinutes must be 1, 3, or 5' };
    }
    const mode = String(config?.mode || 'paper').toLowerCase();
    let isolatedPreflight = { ok: true, skipped: true };
    if ((mode === 'demo' || mode === 'real') && tradeExecutor?.enabled?.()) {
      const hedge = await tradeExecutor.ensureHedgeMode({});
      if (!hedge?.ok) {
        const message = hedge?.error || 'HEDGE MODE REQUIRED: enable Hedge (dual-side) in Bybit account settings, then restart.';
        logger?.warn?.({ mode, error: message }, 'momentum start refused: hedge mode requirement not met');
        return { ok: false, error: 'HEDGE_MODE_REQUIRED', message };
      }
      const firstSymbol = marketData.getEligibleSymbols?.()?.[0] || 'BTCUSDT';
      isolatedPreflight = await tradeExecutor.ensureIsolatedPreflight?.({ symbol: firstSymbol }) || { ok: false, error: 'ISOLATED_PREFLIGHT_UNAVAILABLE' };
      if (!isolatedPreflight?.ok) logger?.warn?.({ mode, error: isolatedPreflight?.error }, 'momentum start isolated preflight failed');
    }
    const inst = createMomentumInstance({ id, config, marketData, sqlite, tradeExecutor, logger, isolatedPreflight });
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
    list: () => ({ ok: true, instances: [...instances.values()].map((x) => withPreflight(x.getLight())) }),
    getState: (instanceId) => {
      const inst = instances.get(instanceId);
      if (!inst) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, stateSnapshot: { ...inst.getSnapshot(), ...withPreflight({}) } };
    },
    getPositions: (instanceId) => {
      const inst = instances.get(instanceId);
      if (!inst) return { ok: false, reason: 'NOT_FOUND' };
      return { ok: true, positions: inst.getSnapshot().openPositions };
    },
    getTrades: async (instanceId, limit, offset) => ({ ok: true, ...(await sqlite.getTrades(instanceId, limit, offset)) }),
    getMarketStatus: () => ({ ok: true, ...getMarketStatus() }),
    cancelEntry,
    onState: (fn) => emitter.on('state', fn),
  };
}

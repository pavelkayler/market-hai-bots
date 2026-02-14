import { EventEmitter } from 'events';
import { createMomentumInstance } from './momentumInstance.js';

export function createMomentumManager({ marketData, sqlite, tradeExecutor = null, logger = console, getUniverseBySource = () => [], getUniverseTiers = () => [] }) {
  const emitter = new EventEmitter();
  const instances = new Map();


  function normalizeUniverseSource(universeSource) {
    const raw = String(universeSource || 'TIER_1').toUpperCase();
    if (/^TIER_\d+$/.test(raw)) return raw;
    if (raw === 'FAST') return 'TIER_1';
    if (raw === 'SLOW') return 'TIER_2';
    return 'TIER_1';
  }
  function normalizeDirection(directionMode) {
    const d = String(directionMode || 'BOTH').toUpperCase();
    return d === 'LONG' || d === 'SHORT' ? d : 'BOTH';
  }

  function isHedgeRequiredForNewInstance(newCfg, runningConfigs = []) {
    const mode = String(newCfg?.mode || 'demo').toLowerCase();
    if (mode === 'paper') return false;
    const newDir = normalizeDirection(newCfg?.directionMode);
    if (newDir === 'BOTH') return true;

    const activeDirs = new Set();
    for (const cfg of runningConfigs) {
      const runMode = String(cfg?.mode || 'demo').toLowerCase();
      if (runMode === 'paper') continue;
      activeDirs.add(normalizeDirection(cfg?.directionMode));
    }
    if (activeDirs.has('BOTH')) return true;
    return newDir === 'LONG' ? activeDirs.has('SHORT') : activeDirs.has('LONG');
  }

  function isHedgeRequiredForRunningInstances() {
    const runningConfigs = [...instances.values()].map((x) => x.getSnapshot?.()?.config).filter(Boolean);
    return runningConfigs.some((cfg, idx) => isHedgeRequiredForNewInstance(cfg, runningConfigs.filter((_, i) => i !== idx)));
  }

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
    const hedgeRequired = isHedgeRequiredForRunningInstances();
    const lastHedgeModeError = hedgeRequired ? (pre.lastHedgeModeError || null) : null;
    return {
      ...base,
      marginMode: pre.marginMode || 'UNKNOWN',
      lastMarginModeCheckTs: pre.lastMarginModeCheckTs || null,
      lastMarginModeError: pre.lastMarginModeError || null,
      hedgeMode: pre.hedgeMode || 'UNKNOWN',
      hedgeRequired,
      lastHedgeModeCheckTs: pre.lastHedgeModeCheckTs || null,
      lastHedgeModeError,
    };
  }

  function emitState() {
    emitter.emit('state', { market: getMarketStatus(), instances: [...instances.values()].map((x) => withPreflight(x.getLight())) });
  }

  function syncActiveIntervals() {
    const intervals = [...instances.values()].map((x) => Number(x.getLight().windowMinutes));
    marketData.setActiveIntervals?.(intervals);
  }

  function syncSelectionPolicy() {
    marketData.setSelectionPolicy?.({ cap: 200, turnover24hMin: 0, vol24hMin: 0 });
    marketData.reconcileSubscriptions?.('policyChange').catch?.(() => {});
  }


  function syncPinnedSymbols() {
    const pinned = new Set();
    for (const inst of instances.values()) {
      const cfg = inst.getSnapshot?.()?.config || {};
      if (cfg.scanMode === 'SINGLE') {
        const sym = String(cfg.singleSymbol || '').toUpperCase().trim();
        if (sym) pinned.add(sym);
        continue;
      }
      for (const sym of Array.isArray(cfg.evalSymbols) ? cfg.evalSymbols : []) if (sym) pinned.add(String(sym).toUpperCase());
    }
    marketData.setPinnedSymbols?.([...pinned]);
  }

  marketData.onTick(async (tick) => {
    for (const inst of instances.values()) {
      const cfg = inst.getSnapshot?.()?.config || {};
      const singleSymbol = String(cfg.singleSymbol || '').toUpperCase().trim();
      const evalSymbols = cfg.scanMode === 'SINGLE' && singleSymbol
        ? [singleSymbol]
        : (Array.isArray(cfg.evalSymbols) ? cfg.evalSymbols : []);
      await inst.onTick(tick, evalSymbols);
    }
    emitState();
  });

  async function start(config) {
    const id = `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const windowMinutes = Number(config?.windowMinutes);
    if (![1, 3, 5].includes(windowMinutes)) {
      return { ok: false, error: 'INVALID_WINDOW_MINUTES', message: 'windowMinutes must be 1, 3, or 5' };
    }
    const mode = String(config?.mode || 'demo').toLowerCase();
    const universeMode = String(config?.universeMode || '').toUpperCase() === 'SINGLE' ? 'SINGLE' : 'TIERS';
    const scanMode = universeMode === 'SINGLE' ? 'SINGLE' : 'UNIVERSE';
    const tiers = Array.isArray(getUniverseTiers?.()) ? getUniverseTiers() : [];
    const totalTiers = tiers.length;
    const tierIndices = [...new Set((Array.isArray(config?.tierIndices) ? config.tierIndices : [config?.tierIndex ?? config?.universeTierIndex])
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0))].sort((a, b) => a - b);
    const universeSource = tierIndices.length > 0 ? normalizeUniverseSource(`TIER_${tierIndices[0]}`) : 'TIER_1';
    let singleSymbol = String(config?.singleSymbol || '').trim().toUpperCase();
    let evalSymbols = [];
    let resolvedSymbolsCount = 0;
    if (scanMode === 'SINGLE') {
      if (!singleSymbol) {
        return { ok: false, error: 'SINGLE_SYMBOL_REQUIRED', message: 'singleSymbol is required when universeMode=SINGLE' };
      }
      if (!/^[A-Z0-9]{3,}USDT$/.test(singleSymbol)) {
        return { ok: false, error: 'INVALID_SINGLE_SYMBOL', message: 'singleSymbol must match /^[A-Z0-9]{3,}USDT$/' };
      }
      if (marketData.hasInstrument && !marketData.hasInstrument(singleSymbol)) logger?.warn?.({ symbol: singleSymbol }, 'UNKNOWN_SYMBOL');
    } else {
      singleSymbol = null;
      if (tierIndices.length === 0) return { ok: false, error: 'TIER_INDICES_REQUIRED', message: 'tierIndices is required when universeMode=TIERS' };
      if (totalTiers <= 0) return { ok: false, error: 'UNIVERSE_SOURCE_EMPTY', message: 'Run Universe Search first.' };
      const outOfRange = tierIndices.find((idx) => idx < 1 || idx > totalTiers);
      if (outOfRange) return { ok: false, error: 'TIER_INDEX_OUT_OF_RANGE', message: `tierIndices must be within 1..${totalTiers}` };
      const seen = new Set();
      for (const idx of tierIndices) {
        const tier = tiers.find((x) => Number(x?.tierIndex) === idx);
        for (const symbol of (tier?.symbols || [])) {
          const sym = String(symbol || '').toUpperCase();
          if (!sym || seen.has(sym)) continue;
          seen.add(sym);
          evalSymbols.push(sym);
        }
      }
      if (!Array.isArray(evalSymbols) || evalSymbols.length === 0) return { ok: false, error: 'UNIVERSE_SOURCE_EMPTY', message: 'Run Universe Search first.' };
      resolvedSymbolsCount = evalSymbols.length;
    }
    let isolatedPreflight = { ok: true, skipped: true };
    if ((mode === 'demo' || mode === 'real') && tradeExecutor?.enabled?.()) {
      const runningConfigs = [...instances.values()].map((x) => x.getSnapshot?.()?.config).filter(Boolean);
      const hedgeRequired = isHedgeRequiredForNewInstance(config, runningConfigs);
      if (hedgeRequired) {
        const hedge = await tradeExecutor.getHedgeModeSnapshot?.({ symbol: marketData.getEligibleSymbols?.()?.[0] || 'BTCUSDT' });
        const modeNow = String(hedge?.mode || 'UNKNOWN').toUpperCase();
        if (modeNow === 'ONE_WAY') {
          const message = 'HEDGE MODE REQUIRED: enable Hedge (dual-side) in Bybit account settings, then restart.';
          logger?.warn?.({ mode, error: message }, 'momentum start refused: hedge mode requirement not met');
          return { ok: false, error: 'HEDGE_MODE_REQUIRED', message };
        }
      }
      const firstSymbol = marketData.getEligibleSymbols?.()?.[0] || 'BTCUSDT';
      isolatedPreflight = await tradeExecutor.ensureIsolatedPreflight?.({ symbol: firstSymbol }) || { ok: false, error: 'ISOLATED_PREFLIGHT_UNAVAILABLE' };
      if (!isolatedPreflight?.ok) logger?.warn?.({ mode, error: isolatedPreflight?.error }, 'momentum start isolated preflight failed');
    }
    const normalizedUniverseMode = scanMode === 'SINGLE' ? 'SINGLE' : 'TIERS';
    const inst = createMomentumInstance({ id, config: { ...config, mode, scanMode, universeMode: normalizedUniverseMode, universeTierIndex: scanMode === 'SINGLE' ? null : tierIndices[0], universeSource, singleSymbol, evalSymbols, tierIndices: scanMode === 'SINGLE' ? [] : tierIndices, resolvedSymbolsCount }, marketData, sqlite, tradeExecutor, logger, isolatedPreflight });
    instances.set(id, inst);
    syncActiveIntervals();
    syncSelectionPolicy();
    syncPinnedSymbols();
    emitState();
    return { ok: true, instanceId: id, stateSnapshot: inst.getSnapshot() };
  }

  function stop(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    inst.stop();
    instances.delete(instanceId);
    syncActiveIntervals();
    syncSelectionPolicy();
    syncPinnedSymbols();
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

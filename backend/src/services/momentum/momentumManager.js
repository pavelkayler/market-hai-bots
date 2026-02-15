import { EventEmitter } from 'events';
import { createMomentumInstance } from './momentumInstance.js';

export function createMomentumManager({ marketData, sqlite, tradeExecutor = null, logger = console, getUniverseBySource = () => [], getUniverseTiers = () => [] }) {
  const emitter = new EventEmitter();
  const instances = new Map();

  function normalizeTierIndices(raw) {
    const out = [...new Set((Array.isArray(raw) ? raw : [1, 2, 3, 4, 5, 6]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0 && x <= 6))].sort((a, b) => a - b);
    return out.length ? out : [1, 2, 3, 4, 5, 6];
  }

  function migrateLegacyConfig(config = {}) {
    return {
      ...config,
      tierIndices: normalizeTierIndices(config.tierIndices),
      scanMode: undefined,
      singleSymbol: undefined,
      universeMode: 'TIERS',
    };
  }

  async function persistInstance(inst, wasRunning = null) {
    const snap = inst.getSnapshot?.() || {};
    const light = inst.getLight?.() || {};
    await sqlite.saveInstance?.({
      instanceId: light.id || snap.id,
      createdAtMs: Number(snap.startedAt || Date.now()),
      updatedAtMs: Date.now(),
      configJson: JSON.stringify(snap.config || {}),
      lastSnapshotJson: JSON.stringify({ stats: snap.stats, signalView: (snap.signalView || []).slice(0, 50), signalNotifications: (snap.signalNotifications || []).slice(0, 100), pendingOrders: (snap.pendingOrders || []).slice(0, 100), openPositions: (snap.openPositions || []).slice(0, 50) }),
      wasRunning: wasRunning == null ? (String(light.status || '').toUpperCase() === 'RUNNING') : Boolean(wasRunning),
      lastStoppedAtMs: String(light.status || '').toUpperCase() === 'STOPPED' ? Date.now() : null,
    });
  }

  async function hydratePersistedInstances() {
    const rows = await sqlite.getInstances?.() || [];
    for (const row of rows) {
      try {
        const config = migrateLegacyConfig(JSON.parse(row.configJson || '{}'));
        const inst = createMomentumInstance({ id: row.instanceId, config, marketData, sqlite, tradeExecutor, logger });
        inst.stop();
        instances.set(row.instanceId, inst);
      } catch (err) {
        logger?.warn?.({ err, instanceId: row.instanceId }, 'failed to hydrate momentum instance');
      }
    }
  }


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
      for (const sym of Array.isArray(cfg.evalSymbols) ? cfg.evalSymbols : []) if (sym) pinned.add(String(sym).toUpperCase());
    }
    marketData.setPinnedSymbols?.([...pinned]);
  }

  marketData.onTick(async (tick) => {
    for (const inst of instances.values()) {
      try {
        const cfg = inst.getSnapshot?.()?.config || {};
        const evalSymbols = Array.isArray(cfg.evalSymbols) ? cfg.evalSymbols : [];
        await inst.onTick(tick, evalSymbols);
      } catch (err) {
        logger?.error?.({ err, instanceId: inst.getLight?.()?.id }, 'momentum onTick failed, stopping instance');
        try { inst.stop?.(); } catch {}
        persistInstance(inst, false).catch(() => {});
      }
    }
    emitState();
  });

  async function start(config, { reuseInstanceId = null } = {}) {
    const id = reuseInstanceId || `mom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const windowMinutes = Number(config?.windowMinutes);
    if (![1, 3, 5].includes(windowMinutes)) {
      return { ok: false, error: 'INVALID_WINDOW_MINUTES', message: 'windowMinutes must be 1, 3, or 5' };
    }
    const mode = String(config?.mode || 'demo').toLowerCase();
    const tiers = Array.isArray(getUniverseTiers?.()) ? getUniverseTiers() : [];
    const totalTiers = tiers.length;
    const tierIndices = normalizeTierIndices(config?.tierIndices);
    const universeSource = normalizeUniverseSource(`TIER_${tierIndices[0]}`);
    const evalSymbols = [];
    let resolvedSymbolsCount = 0;
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
    const inst = createMomentumInstance({ id, config: { ...migrateLegacyConfig(config), mode, universeMode: 'TIERS', universeTierIndex: tierIndices[0], universeSource, evalSymbols, tierIndices, resolvedSymbolsCount }, marketData, sqlite, tradeExecutor, logger, isolatedPreflight });
    instances.set(id, inst);
    await persistInstance(inst, true);
    syncActiveIntervals();
    syncSelectionPolicy();
    syncPinnedSymbols();
    emitState();
    return { ok: true, instanceId: id, stateSnapshot: inst.getSnapshot() };
  }

  async function stop(instanceId) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    inst.stop();
    persistInstance(inst, false).catch(() => {});
    syncActiveIntervals();
    syncSelectionPolicy();
    syncPinnedSymbols();
    emitState();
    return { ok: true };
  }

  async function cont(instanceId) {
    const existing = instances.get(instanceId);
    if (existing) {
      existing.start?.();
      await persistInstance(existing, true);
      emitState();
      return { ok: true, instanceId, stateSnapshot: existing.getSnapshot() };
    }
    const rows = await sqlite.getInstances?.() || [];
    const row = rows.find((x) => x.instanceId === instanceId);
    if (!row) return { ok: false, reason: 'NOT_FOUND' };
    const cfg = migrateLegacyConfig(JSON.parse(row.configJson || '{}'));
    return start(cfg, { reuseInstanceId: instanceId });
  }


  async function updateInstanceConfig(instanceId, patch = {}) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    const sanitized = sanitizeConfigPatch(patch);
    const nextConfig = { ...(inst.getSnapshot?.()?.config || {}), ...sanitized };
    inst.setConfig?.(nextConfig);
    await sqlite.updateInstanceConfig?.({ instanceId, config: nextConfig, updatedAtMs: Date.now() });
    await persistInstance(inst, null);
    emitState();
    return { ok: true, config: nextConfig };
  }

  async function deleteInstance(instanceId) {
    const inst = instances.get(instanceId);
    if (inst) {
      inst.stop?.();
      instances.delete(instanceId);
    }
    await sqlite.deleteInstance?.(instanceId);
    syncActiveIntervals();
    syncSelectionPolicy();
    syncPinnedSymbols();
    emitState();
    return { ok: true };
  }


  function sanitizeConfigPatch(patch = {}) {
    const out = {};
    const numericKeys = ['windowMinutes', 'turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct'];
    for (const key of numericKeys) {
      if (!(key in patch)) continue;
      const n = Number(patch[key]);
      if (!Number.isFinite(n)) continue;
      out[key] = n;
    }
    if (patch.mode) out.mode = String(patch.mode).toLowerCase() === 'demo' ? 'demo' : 'paper';
    if (patch.directionMode) out.directionMode = normalizeDirection(patch.directionMode);
    if (Array.isArray(patch.tierIndices)) out.tierIndices = normalizeTierIndices(patch.tierIndices);
    return out;
  }

  function cancelEntry(instanceId, symbol) {
    const inst = instances.get(instanceId);
    if (!inst) return { ok: false, reason: 'NOT_FOUND' };
    return inst.cancelEntry(symbol, { ts: Date.now(), outcome: 'MANUAL_CANCEL', logMessage: 'manual cancel entry' });
  }

  return {
    init: hydratePersistedInstances,
    start,
    continue: cont,
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
    getSignals: async (instanceId, limit) => ({ ok: true, rows: await sqlite.getSignals?.(instanceId, limit) || [] }),
    updateInstanceConfig: async (instanceId, patch) => updateInstanceConfig(instanceId, patch),
    deleteInstance: async (instanceId) => deleteInstance(instanceId),
    getMarketStatus: () => ({ ok: true, ...getMarketStatus() }),
    getFixedSignals: async (instanceId, limit, sinceMs, symbol) => ({ ok: true, rows: await sqlite.getFixedSignals?.({ instanceId, limit, sinceMs, symbol }) || [] }),
    cancelEntry,
    onState: (fn) => emitter.on('state', fn),
  };
}

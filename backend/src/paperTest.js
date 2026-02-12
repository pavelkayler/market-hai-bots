function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, bounds) {
  const min = safeNum(bounds?.min, -Infinity);
  const max = safeNum(bounds?.max, Infinity);
  return Math.max(min, Math.min(max, value));
}

function countBlockers(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const b of Array.isArray(row?.blockers) ? row.blockers : []) {
      const prev = map.get(b.key) || { ...b, key: b.key, count: 0 };
      prev.count += 1;
      prev.value = b.value;
      prev.threshold = b.threshold;
      prev.pass = b.pass;
      prev.detail = b.detail;
      map.set(b.key, prev);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function createPaperTest({
  getLeadLagTop,
  getUniverseSymbols = () => [],
  presetsStore,
  logger = console,
  onEvent = () => {},
  tickMs = 250,
  reasonsEveryMs = 10_000,
} = {}) {
  const state = {
    status: "STOPPED",
    startedAt: null,
    endedAt: null,
    ticks: 0,
    activePresetId: null,
    sessionPresetId: null,
    lastLeadLagTop: [],
    lastNoEntryReasons: [],
  };

  let logs = [];
  let tuneChanges = [];
  let lastNoEntryAt = 0;
  let lastTradeReadyAt = 0;
  let lastTuneAt = 0;

  function emit(type, payload) {
    try { onEvent({ type, payload }); } catch {}
  }

  function getPreset() {
    return presetsStore?.getPresetById(state.sessionPresetId) || presetsStore?.getPresetById(state.activePresetId) || presetsStore?.getActivePreset?.() || null;
  }

  function pushLog(level, msg, extra = {}) {
    const row = { ts: Date.now(), level, msg, ...extra };
    logs.unshift(row);
    logs = logs.slice(0, 500);
    emit("paper.log", row);
  }

  function emitState() {
    emit("paper.state", getState({ includeHistory: false }));
    emit("paper.status", getState({ includeHistory: false }));
  }

  function maybeAutoTune(now) {
    if (state.status !== "RUNNING" || !state.sessionPresetId || !presetsStore) return;
    if (now - lastTradeReadyAt < 5 * 60 * 1000) return;
    if (now - lastTuneAt < 5 * 60 * 1000) return;
    const top = state.lastNoEntryReasons[0];
    if (!top) return;

    const map = {
      minCorr: { step: -0.01, reason: "reduce corr gate" },
      impulseZ: { step: -0.05, reason: "reduce impulse gate" },
      minSamples: { step: -10, reason: "reduce sample gate" },
      minImpulses: { step: -1, reason: "reduce impulses gate" },
      cooldown: { param: "cooldownSec", step: -2, reason: "reduce cooldown" },
      entryWindow: { param: "edgeMult", step: 0.05, reason: "expand entry window" },
    };
    const action = map[top.key] || { param: "minCorr", step: -0.01, reason: "fallback tune" };
    const param = action.param || top.key;

    const preset = presetsStore.getPresetById(state.sessionPresetId);
    if (!preset) return;
    const from = safeNum(preset.params?.[param], null);
    if (from === null) return;
    const to = clamp(from + action.step, preset.bounds?.[param]);
    if (to === from) return;

    const nextParams = { ...preset.params, [param]: to };
    presetsStore.updatePreset(preset.id, { params: nextParams });
    const change = { ts: now, param, from, to, reason: action.reason, bounds: preset.bounds?.[param] || null };
    tuneChanges.unshift(change);
    tuneChanges = tuneChanges.slice(0, 50);
    lastTuneAt = now;
    emit("paper.tune", change);
    pushLog("info", `AUTO-TUNE ${param}: ${from} -> ${to}`, { change });
  }

  function maybeEmitNoEntry(now) {
    if (now - lastNoEntryAt < reasonsEveryMs) return;
    const rows = Array.isArray(state.lastLeadLagTop) ? state.lastLeadLagTop : [];
    const hasReady = rows.some((r) => r?.tradeReady);
    if (hasReady) {
      lastTradeReadyAt = now;
      lastNoEntryAt = now;
      state.lastNoEntryReasons = [];
      return;
    }

    const top = countBlockers(rows).slice(0, 3);
    state.lastNoEntryReasons = top;
    pushLog("info", "NO ENTRY: top reasons", {
      reasons: top.map((x) => ({ key: x.key, value: x.value, threshold: x.threshold, pass: x.pass, detail: x.detail })),
      whatWeWaitNext: top.slice(0, 2).map((x) => x.detail || `wait ${x.key}`),
    });
    lastNoEntryAt = now;
  }

  function step() {
    if (state.status !== "RUNNING") return;
    const now = Date.now();
    state.ticks += 1;
    state.lastLeadLagTop = Array.isArray(getLeadLagTop?.()) ? getLeadLagTop().slice(0, 10) : [];
    maybeEmitNoEntry(now);
    maybeAutoTune(now);
    emitState();
  }

  const timer = setInterval(() => {
    try { step(); } catch (e) { logger?.warn?.({ err: e }, "paper step failed"); }
  }, tickMs);

  function start({ presetId } = {}) {
    if (state.status === "RUNNING" || state.status === "STARTING") return { ok: false };
    state.status = "STARTING";
    state.endedAt = null;
    state.startedAt = null;
    state.ticks = 0;
    state.lastLeadLagTop = [];
    state.lastNoEntryReasons = [];
    pushLog("info", "Starting...");

    const selectedId = presetId || presetsStore?.getState()?.activePresetId;
    const activePreset = presetsStore?.getPresetById(selectedId) || presetsStore?.getActivePreset?.();
    if (!activePreset) {
      pushLog("error", "No active preset");
      state.status = "STOPPED";
      return { ok: false };
    }

    state.activePresetId = activePreset.id;
    const clone = presetsStore.clonePresetAsSession(activePreset.id);
    state.sessionPresetId = clone?.id || null;
    pushLog("info", `Universe loaded (${getUniverseSymbols().length} symbols)`);
    if (state.sessionPresetId) pushLog("info", "Session preset clone created");

    setTimeout(() => {
      state.startedAt = Date.now();
      state.status = "RUNNING";
      pushLog("info", "RUNNING");
      emitState();
    }, 10);
    emitState();
    return { ok: true };
  }

  function stop({ reason = "manual" } = {}) {
    if (state.status === "STOPPED" || state.status === "STOPPING") return { ok: false };
    state.status = "STOPPING";
    emitState();
    setTimeout(() => {
      state.status = "STOPPED";
      state.endedAt = Date.now();
      pushLog("info", `Stopped (${reason})`);
      emitState();
    }, 10);
    return { ok: true };
  }

  function getStats() {
    const preset = getPreset();
    return {
      pnlUSDT: safeNum(preset?.stats?.pnlUsdt, 0),
      trades: safeNum(preset?.stats?.trades, 0),
      winRate: safeNum(preset?.stats?.winRate, 0),
    };
  }

  function getState({ includeHistory = true } = {}) {
    return {
      ...state,
      activePreset: presetsStore?.getPresetById(state.activePresetId) || null,
      sessionPreset: presetsStore?.getPresetById(state.sessionPresetId) || null,
      position: null,
      pending: null,
      stats: getStats(),
      tuneChanges: includeHistory ? tuneChanges.slice(0, 10) : [],
      trades: [],
      logs: includeHistory ? logs.slice(0, 200) : [],
    };
  }

  return { start, stop, getState, dispose: () => clearInterval(timer) };
}

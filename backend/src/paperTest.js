function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function pickExecPrice(t) {
  const bid = safeNum(t?.bid);
  const ask = safeNum(t?.ask);
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return safeNum(t?.last, safeNum(t?.mark));
}

function clamp(value, bounds) {
  const min = safeNum(bounds?.min, -Infinity);
  const max = safeNum(bounds?.max, Infinity);
  return Math.max(min, Math.min(max, value));
}

export function createPaperTest({
  getLeadLagTop,
  getTicker,
  getBars,
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
    lastDecision: "idle",
    lastEntryAttemptAt: null,
    lastReasons: [],
    activePresetId: null,
    sessionPresetId: null,
  };

  let sessionCloneCreated = false;
  let currentPreset = null;
  let pending = null;
  let position = null;
  let logs = [];
  let trades = [];
  let tuneChanges = [];

  let noEntryWindowStart = Date.now();
  let noEntryReasons = new Map();
  let lastTradeAt = 0;
  let lastTuneAt = 0;
  const stableReasonHistory = [];

  function emit(type, payload) {
    try { onEvent({ type, payload }); } catch {}
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

  function addNoEntryReason(reasonKey, value, threshold, pass, waitFor) {
    const key = String(reasonKey);
    const prev = noEntryReasons.get(key) || { count: 0, reasonKey: key, value, threshold, pass, waitFor };
    prev.count += 1;
    prev.value = value;
    prev.threshold = threshold;
    prev.pass = Boolean(pass);
    prev.waitFor = waitFor;
    noEntryReasons.set(key, prev);
  }

  function syncPresetStats() {
    if (!presetsStore || !state.activePresetId) return;
    const pnl = trades.reduce((acc, t) => acc + safeNum(t.pnlUSDT, 0), 0);
    const roiPct = trades.reduce((acc, t) => acc + safeNum(t.roi, 0), 0) * 100;
    const wins = trades.filter((t) => safeNum(t.pnlUSDT, 0) > 0).length;
    const winRate = trades.length ? (wins / trades.length) * 100 : 0;
    const stats = { pnlUsdt: pnl, roiPct, trades: trades.length, winRate };
    presetsStore.upsertStats(state.activePresetId, stats);
    if (state.sessionPresetId) presetsStore.upsertStats(state.sessionPresetId, stats);
  }

  function maybeEmitNoEntryLog(now) {
    if (state.status !== "RUNNING") return;
    if (now - noEntryWindowStart < reasonsEveryMs) return;
    if (lastTradeAt >= noEntryWindowStart) {
      noEntryReasons.clear();
      noEntryWindowStart = now;
      return;
    }

    const top = [...noEntryReasons.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    state.lastReasons = top;
    stableReasonHistory.push(top.map((x) => x.reasonKey).join("|"));
    while (stableReasonHistory.length > 4) stableReasonHistory.shift();

    pushLog("info", "NO ENTRY: top reasons", {
      reasons: top.map((r) => ({ reasonKey: r.reasonKey, value: r.value, threshold: r.threshold, pass: r.pass })),
      whatWeWaitForNext: top.filter((r) => r.waitFor).slice(0, 2).map((r) => r.waitFor),
    });

    noEntryReasons.clear();
    noEntryWindowStart = now;
  }

  function maybeAutoTune(now) {
    if (state.status !== "RUNNING" || !state.sessionPresetId || !presetsStore) return;
    if (now - lastTradeAt < 5 * 60 * 1000) return;
    if (now - lastTuneAt < 2 * 60 * 1000) return;
    if (stableReasonHistory.length < 3) return;
    const last = stableReasonHistory[stableReasonHistory.length - 1];
    if (!last || !stableReasonHistory.every((x) => x === last)) return;

    const map = {
      minCorr: { step: -0.01, reason: "reduce corr gate" },
      impulseZ: { step: -0.05, reason: "reduce impulse gate" },
      confirmZ: { step: -0.05, reason: "reduce confirm gate" },
      edgeMult: { step: -0.05, reason: "reduce edge gate" },
    };
    const keys = Object.keys(map);
    const chosenKey = keys.find((k) => last.includes(k)) || "minCorr";

    const latest = presetsStore.getPresetById(state.sessionPresetId);
    if (!latest) return;
    const from = safeNum(latest[chosenKey]);
    const step = map[chosenKey].step;
    const to = clamp(from + step, latest.bounds?.[chosenKey]);
    if (to === from) return;

    presetsStore.updatePreset(latest.id, { [chosenKey]: to });
    currentPreset = presetsStore.getPresetById(latest.id);
    const change = { ts: now, param: chosenKey, from, to, reason: map[chosenKey].reason, bounds: latest.bounds?.[chosenKey] || null };
    tuneChanges.unshift(change);
    tuneChanges = tuneChanges.slice(0, 50);
    lastTuneAt = now;
    emit("paper.tune", change);
    pushLog("info", `AUTO-TUNE ${chosenKey}: ${from} -> ${to}`, { change });
    emitState();
  }

  function selectCandidate() {
    const rows = Array.isArray(getLeadLagTop?.()) ? getLeadLagTop() : [];
    for (const r of rows) {
      const corr = Math.abs(safeNum(r?.corr, 0));
      const confirm = safeNum(r?.confirmScore, 0);
      const samples = safeNum(r?.samples, 0);
      const impulses = safeNum(r?.impulses, 0);
      const lagMs = safeNum(r?.lagMs, 0);
      const follower = String(r?.follower || "");

      addNoEntryReason("minSamples", samples, 200, samples >= 200, "Need >=200 samples");
      if (samples < 200) continue;

      addNoEntryReason("minImpulses", impulses, 5, impulses >= 5, "Need >=5 impulses");
      if (impulses < 5) continue;

      addNoEntryReason("minCorr", corr, currentPreset.minCorr, corr >= currentPreset.minCorr, `Need corr >= ${currentPreset.minCorr}`);
      if (corr < currentPreset.minCorr) continue;

      addNoEntryReason("confirmZ", confirm, currentPreset.confirmZ, confirm >= currentPreset.confirmZ, `Need confirm >= ${currentPreset.confirmZ}`);
      if (confirm < currentPreset.confirmZ) continue;

      addNoEntryReason("edgeMult", lagMs, 250, lagMs >= 250, "Wait stable lag");
      if (!follower) continue;
      return r;
    }
    return null;
  }

  function tryEnter(now) {
    const universe = new Set(getUniverseSymbols());
    const selected = selectCandidate();
    if (!selected) {
      state.lastDecision = "no_candidate";
      return;
    }

    const symbol = String(selected.follower || "").toUpperCase();
    if (!universe.has(symbol)) {
      addNoEntryReason("universeFilter", 0, 1, false, "Symbol must be in shortlist/universe");
      state.lastDecision = "universe_reject";
      return;
    }

    const cooldownMs = safeNum(currentPreset.cooldownSec, 15) * 1000;
    const sinceTrade = now - lastTradeAt;
    addNoEntryReason("cooldown", sinceTrade, cooldownMs, sinceTrade >= cooldownMs, "Wait cooldown");
    if (sinceTrade < cooldownMs) {
      state.lastDecision = "cooldown";
      return;
    }

    const ticker = getTicker(symbol);
    const price = pickExecPrice(ticker);
    addNoEntryReason("missingBNBData", price === null ? 0 : 1, 1, price !== null, "Need BNB/BT price stream");
    if (price === null) {
      state.lastDecision = "no_price";
      return;
    }

    position = {
      symbol,
      side: safeNum(selected.corr, 0) >= 0 ? "LONG" : "SHORT",
      entryPrice: price,
      entryAt: now,
      qty: (50 * safeNum(currentPreset.riskQtyMultiplier, 1)) / price,
    };
    state.lastEntryAttemptAt = now;
    state.lastDecision = "entry_opened";
    lastTradeAt = now;
    emit("paper.position", position);
    pushLog("info", `Opened ${position.side} ${symbol} @ ${price.toFixed(4)}`);
  }

  function manageOpenPosition(now) {
    if (!position) return;
    const ticker = getTicker(position.symbol);
    const px = pickExecPrice(ticker);
    if (px === null) return;
    if (now - position.entryAt < 20_000) return;

    const pnl = (px - position.entryPrice) * position.qty * (position.side === "LONG" ? 1 : -1);
    const roi = (pnl / 50) || 0;
    const trade = { closedAt: now, symbol: position.symbol, side: position.side, entryPrice: position.entryPrice, exitPrice: px, qty: position.qty, pnlUSDT: pnl, roi, reason: "TIME" };
    trades.push(trade);
    trades = trades.slice(-500);
    emit("paper.trade", trade);
    pushLog("info", `Closed ${trade.side} ${trade.symbol} pnl=${trade.pnlUSDT.toFixed(4)}`);
    position = null;
    emit("paper.position", null);
    syncPresetStats();
  }

  function step() {
    if (state.status !== "RUNNING") return;
    const now = Date.now();
    state.ticks += 1;
    manageOpenPosition(now);
    if (!position) tryEnter(now);
    maybeEmitNoEntryLog(now);
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
    state.lastDecision = "starting";
    pushLog("info", "Starting...");

    const selectedId = presetId || presetsStore?.getState()?.activePresetId;
    const activePreset = presetsStore?.getPresetById(selectedId) || presetsStore?.getActivePreset?.();
    if (!activePreset) {
      pushLog("error", "No active preset");
      state.status = "STOPPED";
      return { ok: false };
    }

    state.activePresetId = activePreset.id;
    pushLog("info", `Universe loaded (${getUniverseSymbols().length} symbols)...`);

    if (!sessionCloneCreated) {
      const clone = presetsStore.clonePresetAsSession(activePreset.id);
      state.sessionPresetId = clone?.id || null;
      sessionCloneCreated = Boolean(clone);
      pushLog("info", "Preset cloned...");
    }
    if (!state.sessionPresetId) {
      const maybeSession = presetsStore.getState().presets.find((p) => p.isSessionClone && p.sourcePresetId === activePreset.id);
      state.sessionPresetId = maybeSession?.id || null;
    }

    currentPreset = presetsStore.getPresetById(state.sessionPresetId) || activePreset;
    noEntryWindowStart = Date.now();
    noEntryReasons.clear();
    stableReasonHistory.length = 0;

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
    const pnl = trades.reduce((acc, t) => acc + safeNum(t.pnlUSDT, 0), 0);
    const wins = trades.filter((t) => safeNum(t.pnlUSDT, 0) > 0).length;
    return { pnlUSDT: pnl, trades: trades.length, winRate: trades.length ? (wins / trades.length) * 100 : 0 };
  }

  function getState({ includeHistory = true } = {}) {
    return {
      ...state,
      activePreset: presetsStore?.getPresetById(state.activePresetId) || null,
      sessionPreset: presetsStore?.getPresetById(state.sessionPresetId) || null,
      pending,
      position,
      stats: getStats(),
      tuneChanges: includeHistory ? tuneChanges.slice(0, 10) : [],
      trades: includeHistory ? trades.slice(-100) : [],
      logs: includeHistory ? logs.slice(0, 200) : [],
    };
  }

  return { start, stop, getState, dispose: () => clearInterval(timer) };
}

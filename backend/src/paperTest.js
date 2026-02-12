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
  getMarketTicker = () => null,
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
    position: null,
    pending: null,
    executionMode: "paper",
    stats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0 },
    quality: {
      signalsCount: 0,
      entriesCount: 0,
      winsCount: 0,
      lossesCount: 0,
      pnlUSDT: 0,
      avgPnL: 0,
      maxDrawdownUSDT: 0,
      lastSignalTs: null,
      lastEntryTs: null,
      signalsPerHour: 0,
      entriesPerHour: 0,
    },
  };

  let logs = [];
  let tuneChanges = [];
  let trades = [];
  let lastNoEntryAt = 0;
  let lastTradeAt = 0;
  let lastTuneAt = 0;
  let peakEquity = 0;
  let rollingPnl = [];

  function updateQualityRates(now = Date.now()) {
    const elapsedMs = Math.max(1, now - (state.startedAt || now));
    const hours = elapsedMs / 3_600_000;
    state.quality.signalsPerHour = state.quality.signalsCount / hours;
    state.quality.entriesPerHour = state.quality.entriesCount / hours;
  }

  function emit(type, payload) {
    try { onEvent({ type, payload }); } catch {}
  }

  function emitLeadLag(type, payload) {
    emit(type, payload);
    const legacyType = type.replace("leadlag.", "paper.");
    emit(legacyType, payload);
  }

  function getPreset() {
    return presetsStore?.getPresetById(state.sessionPresetId) || presetsStore?.getPresetById(state.activePresetId) || presetsStore?.getActivePreset?.() || null;
  }

  function pushLog(level, msg, extra = {}) {
    const row = { ts: Date.now(), level, msg, ...extra };
    logs.unshift(row);
    logs = logs.slice(0, 500);
    emitLeadLag("leadlag.log", row);
  }

  function emitState() {
    emitLeadLag("leadlag.state", getState({ includeHistory: false }));
    emitLeadLag("leadlag.status", getState({ includeHistory: false }));
  }

  function maybeAutoTune(now) {
    if (state.status !== "RUNNING" || !state.sessionPresetId || !presetsStore) return;
    if (now - lastTradeAt < 4 * 60 * 1000) return;
    if (now - lastTuneAt < 60 * 1000) return;
    const top = state.lastNoEntryReasons[0];
    if (!top) return;

    const map = {
      minCorr: { step: -0.01, reason: "no trades: reduce corr gate" },
      impulseZ: { step: -0.05, reason: "no trades: reduce impulse gate" },
      minSamples: { step: -10, reason: "no trades: reduce sample gate" },
      minImpulses: { step: -1, reason: "no trades: reduce impulses gate" },
      cooldown: { param: "cooldownSec", step: -2, reason: "no trades: reduce cooldown" },
      entryWindow: { param: "edgeMult", step: 0.05, reason: "no trades: expand entry window" },
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
    emitLeadLag("leadlag.tune", change);
    pushLog("info", `AUTO-TUNE ${param}: ${from} -> ${to}`, { change });
  }

  function maybeEmitNoEntry(now) {
    if (now - lastNoEntryAt < reasonsEveryMs) return;
    const rows = Array.isArray(state.lastLeadLagTop) ? state.lastLeadLagTop : [];
    const hasReady = rows.some((r) => r?.tradeReady);
    if (hasReady) {
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

  function maybeOpenTrade(now) {
    if (state.position) return;
    const rows = Array.isArray(state.lastLeadLagTop) ? state.lastLeadLagTop : [];
    const ready = rows.find((r) => r?.tradeReady);
    if (!ready) return;
    state.quality.signalsCount += 1;
    state.quality.lastSignalTs = now;
    updateQualityRates(now);

    const follower = String(ready.follower || "").toUpperCase();
    if (!follower) return;
    const t = getMarketTicker(follower, "BNB") || getMarketTicker(follower, "BT");
    const px = safeNum(t?.mid, safeNum(t?.lastPrice, null));
    if (!Number.isFinite(px) || px <= 0) return;

    const direction = (safeNum(ready.impulseSign, 0) || 0) >= 0 ? "LONG" : "SHORT";
    const tp1 = direction === "LONG" ? px * 1.0015 : px * 0.9985;
    const tp2 = direction === "LONG" ? px * 1.003 : px * 0.997;
    const tp3 = direction === "LONG" ? px * 1.0045 : px * 0.9955;
    const sl = direction === "LONG" ? px * 0.9985 : px * 1.0015;

    const riskNotional = Math.min(100, safeNum(getPreset()?.params?.maxNotionalUsd, 100));
    const qty = riskNotional / px;

    state.position = {
      symbol: follower,
      side: direction,
      entryPrice: px,
      slPrice: sl,
      tpPrices: [tp1, tp2, tp3],
      openedAt: now,
      qty,
      tpsHit: 0,
      feeRate: 0.0002,
    };
    state.quality.entriesCount += 1;
    state.quality.lastEntryTs = now;
    updateQualityRates(now);

    emitLeadLag("leadlag.position", state.position);
    emitLeadLag("leadlag.trade", { ts: now, event: "OPEN", symbol: follower, side: direction, entry: px, sl: sl, tpPrices: [tp1, tp2, tp3], qty, mode: state.executionMode });
    pushLog("info", `OPEN ${direction} ${follower} @ ${px.toFixed(4)} (source=${t?.source || "BNB"})`);
  }

  function maybeCloseTrade(now) {
    const p = state.position;
    if (!p) return;

    const t = getMarketTicker(p.symbol, "BNB") || getMarketTicker(p.symbol, "BT");
    const px = safeNum(t?.mid, safeNum(t?.lastPrice, null));
    if (!Number.isFinite(px) || px <= 0) return;

    const stopHit = p.side === "LONG" ? px <= p.slPrice : px >= p.slPrice;
    const tpHit = p.side === "LONG" ? px >= p.tpPrices[p.tpsHit] : px <= p.tpPrices[p.tpsHit];

    if (!stopHit && !tpHit) return;

    let reason = "SL";
    let exit = px;

    if (tpHit) {
      p.tpsHit += 1;
      if (p.tpsHit < p.tpPrices.length) {
        if (p.tpsHit === 1) p.slPrice = p.entryPrice;
        pushLog("info", `TP${p.tpsHit} hit on ${p.symbol}, moving on`);
        return;
      }
      reason = "TP3";
      exit = p.tpPrices[p.tpPrices.length - 1];
    }

    const signed = p.side === "LONG" ? (exit - p.entryPrice) : (p.entryPrice - exit);
    const gross = signed * p.qty;
    const fees = (p.entryPrice + exit) * p.qty * p.feeRate;
    const pnl = gross - fees;

    const tradeRow = {
      ts: now,
      event: "CLOSE",
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: exit,
      pnlUSDT: pnl,
      reason,
      source: t?.source || "BNB",
    };

    state.stats.trades += 1;
    state.stats.pnlUSDT += pnl;
    if (pnl >= 0) state.stats.wins += 1;
    else state.stats.losses += 1;
    state.stats.winRate = state.stats.trades ? (state.stats.wins / state.stats.trades) * 100 : 0;
    state.quality.pnlUSDT = state.stats.pnlUSDT;
    state.quality.winsCount = state.stats.wins;
    state.quality.lossesCount = state.stats.losses;
    rollingPnl.unshift(pnl);
    rollingPnl = rollingPnl.slice(0, 30);
    state.quality.avgPnL = rollingPnl.length ? rollingPnl.reduce((acc, x) => acc + x, 0) / rollingPnl.length : 0;
    peakEquity = Math.max(peakEquity, state.quality.pnlUSDT);
    state.quality.maxDrawdownUSDT = Math.max(state.quality.maxDrawdownUSDT, peakEquity - state.quality.pnlUSDT);

    trades.unshift(tradeRow);
    trades = trades.slice(0, 200);
    emitLeadLag("leadlag.trade", tradeRow);
    pushLog("info", `CLOSE ${p.side} ${p.symbol} ${reason} pnl=${pnl.toFixed(4)} USDT`);

    if (state.sessionPresetId) {
      presetsStore?.upsertStats?.(state.sessionPresetId, {
        pnlUsdt: state.stats.pnlUSDT,
        trades: state.stats.trades,
        winRate: state.stats.winRate,
      });
    }

    state.position = null;
    emitLeadLag("leadlag.position", null);
    lastTradeAt = now;
  }

  function step() {
    if (state.status !== "RUNNING") return;
    const now = Date.now();
    state.ticks += 1;
    state.lastLeadLagTop = Array.isArray(getLeadLagTop?.()) ? getLeadLagTop().slice(0, 10) : [];
    maybeOpenTrade(now);
    maybeCloseTrade(now);
    maybeEmitNoEntry(now);
    maybeAutoTune(now);
    updateQualityRates(now);
    emitState();
  }

  const timer = setInterval(() => {
    try { step(); } catch (e) { logger?.warn?.({ err: e }, "leadlag paper step failed"); }
  }, tickMs);

  function start({ presetId, mode = "paper" } = {}) {
    if (state.status === "RUNNING" || state.status === "STARTING") return { ok: false };
    state.status = "STARTING";
    state.executionMode = mode;
    state.endedAt = null;
    state.startedAt = null;
    state.ticks = 0;
    state.position = null;
    state.lastLeadLagTop = [];
    state.lastNoEntryReasons = [];
    state.quality = {
      signalsCount: 0,
      entriesCount: 0,
      winsCount: 0,
      lossesCount: 0,
      pnlUSDT: 0,
      avgPnL: 0,
      maxDrawdownUSDT: 0,
      lastSignalTs: null,
      lastEntryTs: null,
      signalsPerHour: 0,
      entriesPerHour: 0,
    };
    peakEquity = 0;
    rollingPnl = [];
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
      pushLog("info", `RUNNING mode=${mode}`);
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
      state.position = null;
      state.endedAt = Date.now();
      pushLog("info", `Stopped (${reason})`);
      emitState();
    }, 10);
    return { ok: true };
  }

  function getState({ includeHistory = true } = {}) {
    const base = {
      ...state,
      activePreset: presetsStore?.getPresetById(state.activePresetId) || null,
      sessionPreset: presetsStore?.getPresetById(state.sessionPresetId) || null,
      pending: null,
    };
    if (includeHistory) {
      base.tuneChanges = tuneChanges.slice(0, 10);
      base.trades = trades.slice(0, 100);
      base.logs = logs.slice(0, 200);
    }
    return base;
  }

  return { start, stop, getState, dispose: () => clearInterval(timer) };
}

// backend/src/paperTest.js
// Paper trading loop for lead-lag strategy (no real orders).
// Purpose: make the workflow visible (RUNNING timer, logs, "why no entries"),
// and keep the backend autonomous (runs even if UI is closed).

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickExecPrice(t) {
  // Approx execution price: mid -> last -> mark
  const bid = safeNum(t?.bid);
  const ask = safeNum(t?.ask);
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  const last = safeNum(t?.last);
  if (last !== null) return last;
  const mark = safeNum(t?.mark);
  if (mark !== null) return mark;
  return null;
}

function fmtPct(x) {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(2)}%`;
}

export function createPaperTest({
  getLeadLagTop,
  getTicker,
  getBars,
  logger = console,
  onEvent = () => {},
  tickMs = 250,
  reasonsEveryMs = 10000,
  maxLogs = 300,
  maxTrades = 500,
} = {}) {
  const defaultPreset = {
    name: "default",

    // gating
    minAbsCorr: 0.12,
    minConfirmScore: 0.85,

    // impulse detection on leader
    impulseLookbackBars: 4, // ~1s on 250ms bars
    leaderMoveMinAbs: 0.0010, // 10 bps log-return

    // lag handling
    minLagMs: 250,
    maxLagMs: 5000,

    // risk / trade
    notionalUSDT: 50,
    tpBps: 0.0030, // 30 bps
    slBps: 0.0020, // 20 bps
    maxHoldMs: 60000,
    cooldownMs: 15000,

    // fees (rough)
    feeBpsPerSide: 0.0006,
  };

  let status = "STOPPED"; // STOPPED | STARTING | RUNNING | STOPPING
  let startedAt = null;
  let endsAt = null;
  let preset = { ...defaultPreset };

  let position = null; // {symbol, side, qty, entryPrice, entryAt, tpPrice, slPrice, ...}
  let pending = null; // {symbol, side, createdAt, executeAt, ctx}

  let trades = [];
  let logs = [];

  let lastTickAt = null;
  let lastTradeAt = 0;

  let reasonsWindowStartedAt = Date.now();
  let reasonsCounter = new Map();

  function emit(type, payload) {
    try {
      onEvent({ type, payload });
    } catch {}
  }

  function pushLog(level, msg, extra = null) {
    const entry = {
      ts: Date.now(),
      level,
      msg,
      ...(extra && typeof extra === "object" ? extra : {}),
    };
    logs.unshift(entry);
    if (logs.length > maxLogs) logs.length = maxLogs;
    emit("paper.log", entry);
  }

  function setStatus(next, note = "") {
    if (status === next) return;
    status = next;
    emit("paper.status", getState({ includeHistory: false }));
    if (note) pushLog("info", note);
  }

  function resetReasonsWindow() {
    reasonsCounter = new Map();
    reasonsWindowStartedAt = Date.now();
  }

  function addReason(reason) {
    const key = String(reason || "").trim();
    if (!key) return;
    reasonsCounter.set(key, (reasonsCounter.get(key) || 0) + 1);
  }

  function flushReasonsIfDue() {
    const now = Date.now();
    if (now - reasonsWindowStartedAt < reasonsEveryMs) return;

    const entries = [...reasonsCounter.entries()];
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 3);

    if (top.length) {
      const parts = top.map(([r, c]) => `${r} (${c})`).join(", ");
      pushLog(
        "info",
        `Почему нет входа (последние ${(reasonsEveryMs / 1000) | 0}s): ${parts} | пороги: minAbsCorr=${preset.minAbsCorr}, minConfirmScore=${preset.minConfirmScore}, leaderMoveMinAbs=${preset.leaderMoveMinAbs}, cooldown=${(preset.cooldownMs / 1000) | 0}s`
      );
    } else {
      pushLog(
        "info",
        `Почему нет входа (последние ${(reasonsEveryMs / 1000) | 0}s): нет данных | пороги: minAbsCorr=${preset.minAbsCorr}, minConfirmScore=${preset.minConfirmScore}, leaderMoveMinAbs=${preset.leaderMoveMinAbs}`
      );
    }

    resetReasonsWindow();
  }

  function computeFeeUSDT(notional) {
    const n = safeNum(notional);
    if (n === null) return 0;
    const perSide = preset.feeBpsPerSide || 0;
    return n * perSide * 2; // entry + exit
  }

  function openPosition({ symbol, side, price, ctx }) {
    const notional = preset.notionalUSDT;
    const qty = notional / price;

    const tp = side === "LONG" ? price * (1 + preset.tpBps) : price * (1 - preset.tpBps);
    const sl = side === "LONG" ? price * (1 - preset.slBps) : price * (1 + preset.slBps);

    position = {
      symbol,
      side,
      qty,
      notionalUSDT: notional,
      entryPrice: price,
      entryAt: Date.now(),
      tpPrice: tp,
      slPrice: sl,
      ctx: ctx || null,
    };

    emit("paper.position", position);
    pushLog(
      "info",
      `Открыта позиция: ${side} ${symbol} qty≈${qty.toFixed(6)} entry=${price.toFixed(4)} TP=${tp.toFixed(4)} SL=${sl.toFixed(4)}`
    );

    lastTradeAt = Date.now();
    resetReasonsWindow();
  }

  function closePosition({ price, reason }) {
    if (!position) return;

    const sideSign = position.side === "LONG" ? 1 : -1;
    const pnl = (price - position.entryPrice) * position.qty * sideSign;
    const roi = pnl / position.notionalUSDT;
    const fee = computeFeeUSDT(position.notionalUSDT);

    const trade = {
      closedAt: Date.now(),
      symbol: position.symbol,
      side: position.side,
      qty: position.qty,
      entryPrice: position.entryPrice,
      exitPrice: price,
      pnlUSDT: pnl - fee,
      pnlGrossUSDT: pnl,
      feesUSDT: fee,
      roi,
      holdMs: Date.now() - position.entryAt,
      reason,
      ctx: position.ctx || null,
    };

    trades.push(trade);
    if (trades.length > maxTrades) trades = trades.slice(trades.length - maxTrades);

    emit("paper.trade", trade);
    pushLog(
      "info",
      `Закрыта позиция: ${trade.side} ${trade.symbol} exit=${price.toFixed(4)} PnL=${trade.pnlUSDT.toFixed(4)} (${fmtPct(trade.roi)}) reason=${reason}`
    );

    position = null;
    emit("paper.position", null);

    resetReasonsWindow();
  }

  function pickCandidate() {
    const top = Array.isArray(getLeadLagTop?.()) ? getLeadLagTop() : [];
    for (const r of top) {
      const corr = safeNum(r?.corr);
      const cs = safeNum(r?.confirmScore);
      if (corr === null || cs === null) continue;

      const ok =
        r?.confirmed === true &&
        Math.abs(corr) >= preset.minAbsCorr &&
        cs >= preset.minConfirmScore;

      if (ok) return r;
    }
    return null;
  }

  function leaderImpulseOk(candidate) {
    const leader = candidate.leader;
    const src = String(candidate.leaderSrc || "binance").toLowerCase();

    const need = (preset.impulseLookbackBars | 0) + 1;
    const bars = Array.isArray(getBars?.(leader, need, src)) ? getBars(leader, need, src) : [];
    if (bars.length < need) return { ok: false, reason: `мало баров лидера (${bars.length}/${need})` };

    const a = bars[bars.length - 1];
    const b = bars[bars.length - 1 - (preset.impulseLookbackBars | 0)];

    const c1 = safeNum(a?.c);
    const c0 = safeNum(b?.c);
    if (c1 === null || c0 === null || c1 <= 0 || c0 <= 0) return { ok: false, reason: "битые цены лидера" };

    const r = Math.log(c1 / c0);
    const abs = Math.abs(r);

    if (abs < preset.leaderMoveMinAbs) {
      return { ok: false, reason: `импульс слабый (|r|=${abs.toFixed(5)} < ${preset.leaderMoveMinAbs})` };
    }

    return { ok: true, leaderReturn: r };
  }

  function armSignal(candidate, leaderReturn) {
    const corr = safeNum(candidate.corr) ?? 0;
    const lagMs = clamp(safeNum(candidate.lagMs) ?? 250, preset.minLagMs, preset.maxLagMs);

    const leaderSign = Math.sign(leaderReturn) || 0;
    const corrSign = Math.sign(corr) || 0;

    // expected follower sign: same if corr>0, opposite if corr<0
    const expectedSign = leaderSign * (corrSign === 0 ? 1 : corrSign);
    const side = expectedSign >= 0 ? "LONG" : "SHORT";

    pending = {
      symbol: candidate.follower,
      side,
      createdAt: Date.now(),
      executeAt: Date.now() + lagMs,
      ctx: {
        leader: candidate.leader,
        follower: candidate.follower,
        corr: candidate.corr,
        lagMs,
        samples: candidate.samples,
        impulses: candidate.impulses,
        confirmScore: candidate.confirmScore,
        leaderSrc: candidate.leaderSrc || "bybit",
        followerSrc: candidate.followerSrc || "bybit",
        leaderReturn,
      },
    };

    emit("paper.pending", pending);

    pushLog(
      "info",
      `Сигнал поставлен в ожидание: ${pending.ctx.leader} -> ${pending.ctx.follower} corr=${corr.toFixed(3)} lag=${(lagMs / 1000).toFixed(2)}s leaderR=${leaderReturn.toFixed(5)} => ${side} ${pending.symbol}`
    );

    resetReasonsWindow();
  }

  function maybeExecutePending() {
    if (!pending) return false;
    const now = Date.now();
    if (now < pending.executeAt) {
      addReason("ждём лаг (pending)");
      return false;
    }

    if (position) {
      pushLog("warn", "Пропуск pending: позиция уже открыта");
      pending = null;
      emit("paper.pending", null);
      return false;
    }

    const t = getTicker?.(pending.symbol);
    const px = pickExecPrice(t);
    if (px === null) {
      pushLog("warn", `Пропуск pending: нет цены ${pending.symbol}`);
      pending = null;
      emit("paper.pending", null);
      return false;
    }

    const ctx = pending.ctx;
    const side = pending.side;
    const symbol = pending.symbol;

    pending = null;
    emit("paper.pending", null);

    openPosition({ symbol, side, price: px, ctx });
    return true;
  }

  function maybeManagePosition() {
    if (!position) return false;

    const t = getTicker?.(position.symbol);
    const px = pickExecPrice(t);
    if (px === null) {
      addReason("нет цены для позиции");
      return false;
    }

    const now = Date.now();
    const holdMs = now - position.entryAt;

    if (holdMs >= preset.maxHoldMs) {
      closePosition({ price: px, reason: "TIME" });
      return true;
    }

    if (position.side === "LONG") {
      if (px >= position.tpPrice) {
        closePosition({ price: px, reason: "TP" });
        return true;
      }
      if (px <= position.slPrice) {
        closePosition({ price: px, reason: "SL" });
        return true;
      }
      addReason("позиция открыта");
      return false;
    }

    // SHORT
    if (px <= position.tpPrice) {
      closePosition({ price: px, reason: "TP" });
      return true;
    }
    if (px >= position.slPrice) {
      closePosition({ price: px, reason: "SL" });
      return true;
    }

    addReason("позиция открыта");
    return false;
  }

  function maybeArmNewSignal() {
    if (position) {
      addReason("позиция открыта");
      return false;
    }

    if (pending) {
      addReason("ждём lag (pending)");
      return false;
    }

    const now = Date.now();
    if (now - lastTradeAt < preset.cooldownMs) {
      addReason(`cooldown (${((preset.cooldownMs - (now - lastTradeAt)) / 1000) | 0}s)`);
      return false;
    }

    const cand = pickCandidate();
    if (!cand) {
      addReason("нет пары по порогам (corr/confirm)");
      return false;
    }

    const imp = leaderImpulseOk(cand);
    if (!imp.ok) {
      addReason(imp.reason);
      return false;
    }

    armSignal(cand, imp.leaderReturn);
    return true;
  }

  function step() {
    lastTickAt = Date.now();

    if (status !== "RUNNING") return;

    let did = false;

    // 1) manage position (exit)
    if (maybeManagePosition()) did = true;

    // 2) pending execution
    if (!did && maybeExecutePending()) did = true;

    // 3) arm new signal
    if (!did) {
      if (maybeArmNewSignal()) did = true;
    }

    // 4) if nothing happened, accumulate reasons + periodic flush
    if (!did) {
      flushReasonsIfDue();
    }
  }

  const timer = setInterval(() => {
    try {
      step();
    } catch (e) {
      logger?.warn?.({ err: e }, "paperTest step failed");
    }
  }, tickMs);

  function start({ preset: presetOverride } = {}) {
    if (status === "RUNNING" || status === "STARTING") return { ok: false, reason: "already running" };

    endsAt = null;
    position = null;
    pending = null;
    emit("paper.position", null);
    emit("paper.pending", null);

    preset = { ...defaultPreset, ...(presetOverride && typeof presetOverride === "object" ? presetOverride : {}) };

    setStatus("STARTING", `PaperTest: старт (${preset.name})`);

    // async start (fast ACK pattern)
    setTimeout(() => {
      startedAt = Date.now();
      lastTradeAt = 0;
      resetReasonsWindow();
      setStatus("RUNNING", "PaperTest: RUNNING");
    }, 200);

    return { ok: true };
  }

  function stop({ reason = "manual" } = {}) {
    if (status === "STOPPED" || status === "STOPPING") return { ok: false, reason: "already stopped" };

    setStatus("STOPPING", `PaperTest: остановка (${reason})`);

    setTimeout(() => {
      status = "STOPPED";
      endsAt = Date.now();
      emit("paper.status", getState({ includeHistory: false }));
      pushLog("info", "PaperTest: STOPPED");
    }, 150);

    return { ok: true };
  }

  function getStats() {
    const n = trades.length;
    let pnl = 0;
    let wins = 0;
    let losses = 0;
    for (const t of trades) {
      const p = safeNum(t.pnlUSDT) || 0;
      pnl += p;
      if (p > 0) wins++;
      else if (p < 0) losses++;
    }
    const roi = trades.reduce((acc, t) => acc + (safeNum(t.roi) || 0), 0);

    return {
      trades: n,
      wins,
      losses,
      pnlUSDT: pnl,
      roiSum: roi,
    };
  }

  function getState({ includeHistory = true } = {}) {
    return {
      status,
      startedAt,
      endsAt,
      lastTickAt,
      preset,
      position,
      pending,
      stats: getStats(),
      trades: includeHistory ? trades.slice(-100) : [],
      logs: includeHistory ? logs.slice(0, 200) : [],
    };
  }

  function dispose() {
    clearInterval(timer);
  }

  return {
    start,
    stop,
    getState,
    dispose,
  };
}

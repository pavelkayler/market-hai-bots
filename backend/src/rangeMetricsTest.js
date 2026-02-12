// backend/src/rangeMetricsTest.js
// Sideways range strategy (metrics-driven) inspired by chat_export.md.
// Trades range edges (1h range), confirmation on 5m reclaim + volume spike,
// gates with funding/OI and optional liquidation spike (if feed provided).
// Supports mode: paper | demo (demo uses Bybit private REST via trade executor).

import { atr, lastClosedCandle } from "./ta.js";

function now() { return Date.now(); }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function fmt(x, d = 6) { const n = num(x); return Number.isFinite(n) ? n.toFixed(d) : "—"; }

function makeLog(level, msg, meta) {
  return { t: now(), level, msg, meta };
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function sideToBybit(side) { return side === "LONG" ? "Buy" : "Sell"; }

function inBand(px, level, band) {
  return Math.abs(px - level) <= band;
}

function reclaimTrigger({ side, level, prev5, cur5, buffer }) {
  if (!prev5 || !cur5) return false;
  if (side === "LONG") {
    const wasBelow = (prev5.c < level - buffer) || (prev5.l < level - buffer);
    const reclaimed = cur5.c > level + buffer;
    const poked = cur5.l < level - buffer;
    return reclaimed && (wasBelow || poked);
  }
  const wasAbove = (prev5.c > level + buffer) || (prev5.h > level + buffer);
  const reclaimed = cur5.c < level - buffer;
  const poked = cur5.h > level + buffer;
  return reclaimed && (wasAbove || poked);
}

function pickRange(c60) {
  // Simple 1h range: highest high / lowest low of last N candles
  if (!Array.isArray(c60) || c60.length < 50) return null;
  const win = c60.slice(-72); // ~3 days
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of win) {
    if (num(c.h) > hi) hi = c.h;
    if (num(c.l) < lo) lo = c.l;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return null;
  return { hi, lo, size: hi - lo };
}

function volSpike(c5, lookback = 30, mult = 2.0) {
  if (!Array.isArray(c5) || c5.length < lookback + 5) return { ok: false };
  const win = c5.slice(-(lookback + 1), -1);
  const last = c5[c5.length - 1];
  const v = num(last?.v);
  if (!Number.isFinite(v)) return { ok: false };
  const avg = win.reduce((s, c) => s + (num(c.v) || 0), 0) / win.length;
  if (!Number.isFinite(avg) || avg <= 0) return { ok: false };
  return { ok: true, v, avg, ratio: v / avg, hit: (v / avg) >= mult };
}

export function createRangeMetricsTest({
  universe,
  klines,
  bybitRest,
  liqFeed, // optional: { getRollingUsd(symbol, windowMs) -> {usd,buyUsd,sellUsd,count} }
  trade,   // optional: Bybit trade executor
  logger = console,
  onEvent = () => {},
} = {}) {
  const defaults = {
    mode: "paper", // paper | demo

    intervals: { tf5: "5", tf60: "60" },
    candlesLimit: 220,

    // range edge detection
    edgeFrac: 0.20,

    // trigger buffers
    bandAtrMult: 0.35,
    reclaimBufferAtr5: 0.10,

    // volume + liquidation filters
    volLookback5: 30,
    volSpikeMult: 2.0,
    liqWindowMs: 20 * 60 * 1000,
    liqSpikeUsd: 250_000,

    // derivatives gates
    fundingAbsMax: 0.0005,
    oiDropMinPct: 0.0, // keep simple

    // risk
    riskUSDT: 10,
    minRR1: 0.8,

    // exits (paper) or TP legs (demo)
    tpR: [1.0, 2.0, 3.0],
    weights: [0.4, 0.3, 0.3],
    moveSlToBEAfterTP1: true,

    // scan
    scanPerTick: 4,
    tickMs: 2500,
    cooldownMs: 60_000,
    noTradeLogEveryMs: 10_000,
  };

  const state = {
    status: "STOPPED",
    startedAt: null,
    endedAt: null,
    preset: { ...defaults },

    stats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 },

    position: null,
    trades: [],
    logs: [],

    scan: {
      universeStatus: null,
      universeSize: 0,
      scanIdx: 0,
      lastScanAt: null,
      lastCandidate: null,
    },

    cooldownUntil: 0,
  };

  let timer = null;
  let noTradeTimer = null;

  function emit(type, payload) {
    onEvent({ type, payload });
  }

  function pushLog(level, msg, meta) {
    const l = makeLog(level, msg, meta);
    state.logs = [l, ...state.logs].slice(0, 300);
    emit("range.log", l);
  }

  function setStatus(next) {
    state.status = next;
    emit("range.status", getState());
  }

  function setPosition(p) {
    state.position = p;
    emit("range.position", p);
  }

  function addTrade(t) {
    state.trades = [...state.trades, t].slice(-200);
    emit("range.trade", t);
  }

  function getState() {
    return { ...state };
  }

  function qtyForRisk({ riskUSDT, entry, sl }) {
    const r = Math.abs(entry - sl);
    if (!Number.isFinite(r) || r <= 0) return null;
    return riskUSDT / r;
  }

  async function computeCandidate(symbol) {
    const p = state.preset;
    const c60 = await klines.getCandles({ symbol, interval: p.intervals.tf60, limit: p.candlesLimit });
    const c5 = await klines.getCandles({ symbol, interval: p.intervals.tf5, limit: p.candlesLimit });
    if (c60.length < 60 || c5.length < 60) return { ok: false, reason: "not_enough_candles" };

    const cur5 = lastClosedCandle(c5);
    const prev5 = c5.length >= 2 ? c5[c5.length - 2] : null;
    const px = num(cur5?.c);
    if (!Number.isFinite(px)) return { ok: false, reason: "no_price" };

    const r = pickRange(c60);
    if (!r) return { ok: false, reason: "no_range" };

    const edgeBand = r.size * p.edgeFrac;
    const nearLow = px <= (r.lo + edgeBand);
    const nearHigh = px >= (r.hi - edgeBand);
    if (!nearLow && !nearHigh) return { ok: false, reason: "range_mid" };

    const a5 = atr(c5, 14);
    const a60 = atr(c60, 14);
    if (!Number.isFinite(a5) || !Number.isFinite(a60)) return { ok: false, reason: "no_atr" };

    const band = a60 * p.bandAtrMult;
    const buffer = a5 * p.reclaimBufferAtr5;

    // choose side and anchor level
    const side = nearLow ? "LONG" : "SHORT";
    const level = nearLow ? r.lo : r.hi;

    // volume spike on last closed 5m
    const vs = volSpike(c5, p.volLookback5, p.volSpikeMult);

    // optional liquidation spike
    let liq = null;
    if (liqFeed && typeof liqFeed.getRollingUsd === "function") {
      liq = liqFeed.getRollingUsd(symbol, p.liqWindowMs);
    }

    // derivatives: funding + OI
    let funding = null;
    let oiNow = null;
    let oiPrev = null;
    try {
      if (bybitRest?.getFundingHistory) {
        const fh = await bybitRest.getFundingHistory({ symbol, limit: 2 });
        funding = num(fh?.[0]?.fundingRate ?? fh?.[0]?.fundingRateStr ?? fh?.[0]?.fundingRate);
        if (!Number.isFinite(funding) && fh?.[0]) funding = num(fh[0].fundingRate);
      }
    } catch {}
    try {
      if (bybitRest?.getOpenInterest) {
        const oi = await bybitRest.getOpenInterest({ symbol, interval: "15", limit: 2 });
        oiNow = num(oi?.[0]?.openInterest ?? oi?.[0]?.openInterestValue ?? oi?.[0]?.oi);
        oiPrev = num(oi?.[1]?.openInterest ?? oi?.[1]?.openInterestValue ?? oi?.[1]?.oi);
      }
    } catch {}

    const fundingOk = !Number.isFinite(funding) || Math.abs(funding) <= p.fundingAbsMax;

    // Trigger: reclaim of range edge
    const trig = reclaimTrigger({ side, level, prev5, cur5, buffer });

    // SL just beyond edge
    const riskPad = buffer;
    const sl = side === "LONG" ? (level - riskPad) : (level + riskPad);
    const risk = Math.abs(px - sl);

    const tp1 = side === "LONG" ? px + p.tpR[0] * risk : px - p.tpR[0] * risk;
    const tp2 = side === "LONG" ? px + p.tpR[1] * risk : px - p.tpR[1] * risk;
    const tp3 = side === "LONG" ? px + p.tpR[2] * risk : px - p.tpR[2] * risk;
    const rr1 = Math.abs(tp1 - px) / risk;

    // scoring: prefer trigger, volSpike, liqSpike
    const liqUsd = num(liq?.usd) || 0;
    const liqHit = liqUsd >= p.liqSpikeUsd;

    return {
      ok: true,
      symbol,
      side,
      px,
      range: r,
      edgeBand,
      level,
      band,
      buffer,
      trigger: trig,
      vol: vs,
      liq: liq ? { ...liq, hit: liqHit } : null,
      funding,
      oiNow,
      oiPrev,
      fundingOk,
      sl,
      tp1,
      tp2,
      tp3,
      rr1,
      score: (trig ? 0 : 1000) + (vs?.hit ? 0 : 50) + (liqHit ? 0 : 25) + (fundingOk ? 0 : 100),
    };
  }

  async function manageDemoPosition(pos) {
    // In demo mode we rely on exchange exits; we just detect closure.
    if (!trade || !trade.enabled()) return;
    try {
      const p = await trade.getPosition({ symbol: pos.symbol });
      const size = num(p?.size);
      if (Number.isFinite(size) && size !== 0) return; // still open

      // closed: fetch closed pnl list and take the latest record(s)
      const list = await trade.getClosedPnl({ symbol: pos.symbol, limit: 5 });
      const last = list?.[0] || null;
      const pnl = num(last?.closedPnl) ?? num(last?.pnl) ?? 0;

      const t = {
        tOpen: pos.openedAt,
        tClose: now(),
        symbol: pos.symbol,
        side: pos.side,
        entry: pos.entry,
        exit: null,
        reason: "EXCHANGE_CLOSE",
        pnlUSDT: pnl,
        mode: "demo",
      };

      state.stats.trades += 1;
      state.stats.pnlUSDT += pnl;
      if (pnl >= 0) state.stats.wins += 1; else state.stats.losses += 1;
      addTrade(t);
      pushLog("info", `CLOSED (demo) ${pos.side} ${pos.symbol} pnl=${fmt(pnl,4)}`, t);
      setPosition(null);
      state.cooldownUntil = now() + state.preset.cooldownMs;
      emit("range.status", getState());
    } catch (e) {
      // no hard fail
    }
  }

  async function tick() {
    const p = state.preset;
    const uStatus = universe.getStatus();
    state.scan.universeStatus = uStatus;

    const u = universe.getUniverse({ limit: 500 });
    state.scan.universeSize = u.length;

    if (uStatus.status !== "ready" || !u.length) {
      return { ok: false, reason: uStatus.status !== "ready" ? "universe_not_ready" : "universe_empty" };
    }

    if (state.position) {
      if (p.mode === "demo") {
        await manageDemoPosition(state.position);
        return { ok: true, action: "manage_demo" };
      }
      // paper manage on 5m candles similar to pullback (simplified)
      const sym = state.position.symbol;
      const c5 = await klines.getCandles({ symbol: sym, interval: p.intervals.tf5, limit: p.candlesLimit });
      const cur5 = lastClosedCandle(c5);
      if (!cur5) return { ok: false, reason: "no_5m" };

      const candle = cur5;
      const pos = state.position;

      // SL/TP conservative
      const side = pos.side;
      const hitSl = side === "LONG" ? (candle.l <= pos.sl) : (candle.h >= pos.sl);
      if (hitSl) {
        const exit = pos.sl;
        const pnl = side === "LONG" ? (exit - pos.entry) * pos.qty : (pos.entry - exit) * pos.qty;
        state.stats.trades += 1;
        state.stats.losses += 1;
        state.stats.pnlUSDT += pnl;
        const t = { tOpen: pos.openedAt, tClose: now(), symbol: pos.symbol, side, entry: pos.entry, exit, reason: "SL", pnlUSDT: pnl, mode: "paper" };
        addTrade(t);
        pushLog("warn", `SL hit ${side} ${pos.symbol} pnl=${fmt(pnl,4)}`, t);
        setPosition(null);
        state.cooldownUntil = now() + p.cooldownMs;
        emit("range.status", getState());
        return { ok: true, action: "sl" };
      }

      // TP ladder
      for (let i = 0; i < pos.legs.length; i++) {
        const leg = pos.legs[i];
        if (leg.done) continue;
        const hitTp = side === "LONG" ? (candle.h >= leg.tp) : (candle.l <= leg.tp);
        if (!hitTp) continue;

        leg.done = true;
        const ex = leg.tp;
        leg.exit = { t: now(), price: ex, reason: `TP${i+1}` };

        if (i === 0 && p.moveSlToBEAfterTP1) {
          pos.sl = pos.entry;
          pushLog("info", `SL moved to BE ${pos.symbol}`, { sl: pos.sl });
        }

        // if last leg done -> close
        if (pos.legs.every((x) => x.done)) {
          let pnl = 0;
          for (const lg of pos.legs) {
            const q = pos.qty * lg.weight;
            pnl += side === "LONG" ? (lg.exit.price - pos.entry) * q : (pos.entry - lg.exit.price) * q;
          }
          state.stats.trades += 1;
          state.stats.pnlUSDT += pnl;
          if (pnl >= 0) state.stats.wins += 1; else state.stats.losses += 1;
          const t = { tOpen: pos.openedAt, tClose: now(), symbol: pos.symbol, side, entry: pos.entry, exit: ex, reason: `TP${i+1}`, pnlUSDT: pnl, mode: "paper" };
          addTrade(t);
          pushLog("info", `CLOSED ${side} ${pos.symbol} pnl=${fmt(pnl,4)}`, t);
          setPosition(null);
          state.cooldownUntil = now() + p.cooldownMs;
          emit("range.status", getState());
          return { ok: true, action: "tp_all" };
        }

        setPosition({ ...pos });
        emit("range.status", getState());
        return { ok: true, action: "tp" };
      }

      setPosition({ ...pos });
      return { ok: true, action: "hold" };
    }

    if (now() < state.cooldownUntil) return { ok: false, reason: "cooldown" };

    const startIdx = state.scan.scanIdx;
    const N = u.length;
    let best = null;
    const reasonCounts = new Map();

    for (let k = 0; k < p.scanPerTick; k++) {
      const idx = (startIdx + k) % N;
      const sym = u[idx];
      const c = await computeCandidate(sym);
      if (!c.ok) {
        reasonCounts.set(c.reason, (reasonCounts.get(c.reason) || 0) + 1);
        continue;
      }
      // gates
      if (!c.fundingOk) {
        reasonCounts.set("funding_extreme", (reasonCounts.get("funding_extreme") || 0) + 1);
        continue;
      }
      if (!best || c.score < best.score) best = c;
    }

    state.scan.scanIdx = (startIdx + p.scanPerTick) % N;
    state.scan.lastScanAt = now();
    state.scan.lastCandidate = best ? {
      symbol: best.symbol,
      side: best.side,
      px: best.px,
      level: best.level,
      trigger: best.trigger,
      rr1: best.rr1,
      funding: best.funding,
      liqUsd: best.liq?.usd ?? null,
      volRatio: best.vol?.ratio ?? null,
      sl: best.sl,
      tp1: best.tp1,
      tp2: best.tp2,
      tp3: best.tp3,
    } : null;

    if (!best) {
      return { ok: false, reason: "no_candidate", reasons: Object.fromEntries(reasonCounts) };
    }

    // entry conditions
    const blockers = [];
    if (!inBand(best.px, best.level, best.band)) blockers.push("not_in_band");
    if (!best.trigger) blockers.push("waiting_reclaim");
    if (!best.vol?.hit) blockers.push("no_vol_spike");
    if (best.liq && !best.liq.hit) blockers.push("no_liq_spike");
    if (best.rr1 < p.minRR1) blockers.push("rr_low");

    if (blockers.length) {
      return { ok: false, reason: "blocked", blockers, candidate: state.scan.lastCandidate };
    }

    const qty = qtyForRisk({ riskUSDT: p.riskUSDT, entry: best.px, sl: best.sl });
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

    const legs = [
      { tp: best.tp1, weight: p.weights[0], done: false },
      { tp: best.tp2, weight: p.weights[1], done: false },
      { tp: best.tp3, weight: p.weights[2], done: false },
    ];

    const pos = {
      symbol: best.symbol,
      side: best.side,
      openedAt: now(),
      entry: best.px,
      sl: best.sl,
      qty,
      legs,
      mode: p.mode,
      meta: { level: best.level, range: best.range, vol: best.vol, liq: best.liq, funding: best.funding },
    };

    setPosition(pos);

    if (p.mode === "demo") {
      // place orders on exchange
      try {
        if (!trade || !trade.enabled()) throw new Error("trade_disabled");
        const side = sideToBybit(pos.side);
        await trade.openPosition({
          symbol: pos.symbol,
          side,
          qty: pos.qty,
          sl: pos.sl,
          tps: [
            { price: pos.legs[0].tp, weight: pos.legs[0].weight },
            { price: pos.legs[1].tp, weight: pos.legs[1].weight },
            { price: pos.legs[2].tp, weight: pos.legs[2].weight },
          ],
          positionIdx: 0,
        });
        pushLog("info", `OPEN (demo) ${pos.side} ${pos.symbol} entry≈${fmt(pos.entry)} sl=${fmt(pos.sl)} qty=${fmt(pos.qty,4)}`, pos);
      } catch (e) {
        pushLog("error", `Demo entry failed: ${e?.message || e}`, { symbol: pos.symbol });
        setPosition(null);
        state.cooldownUntil = now() + p.cooldownMs;
        emit("range.status", getState());
        return { ok: false, reason: "demo_entry_failed" };
      }
    } else {
      pushLog("info", `OPEN (paper) ${pos.side} ${pos.symbol} entry=${fmt(pos.entry)} sl=${fmt(pos.sl)} rr1=${fmt(best.rr1,2)}`, pos);
    }

    emit("range.status", getState());
    return { ok: true, action: "open" };
  }

  async function start({ preset, mode } = {}) {
    if (state.status === "RUNNING" || state.status === "STARTING") return;
    state.preset = { ...defaults, ...(preset && typeof preset === "object" ? preset : {}) };
    if (mode === "demo") state.preset.mode = "demo";

    state.startedAt = now();
    state.endedAt = null;
    state.position = null;
    state.trades = [];
    state.logs = [];
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 };
    state.cooldownUntil = 0;

    setStatus("STARTING");
    pushLog("info", `Range (metrics) starting... mode=${state.preset.mode}`, { preset: state.preset });

    universe.refresh?.().catch(() => {});

    timer = setInterval(() => {
      tick().catch((e) => logger?.warn?.({ err: e }, "range tick failed"));
    }, state.preset.tickMs);

    noTradeTimer = setInterval(() => {
      if (state.status !== "RUNNING") return;
      if (state.position) return;
      const c = state.scan.lastCandidate;
      const reasons = [];
      if (c) {
        reasons.push(`trigger=${c.trigger}`);
        reasons.push(`volRatio=${fmt(c.volRatio,2)}`);
        if (c.liqUsd != null) reasons.push(`liqUsd=${fmt(c.liqUsd,0)}`);
        reasons.push(`rr1=${fmt(c.rr1,2)}`);
      } else {
        reasons.push("no_candidate");
      }
      pushLog("info", `No entry: ${reasons.slice(0,3).join(" | ")}`, { candidate: c });
    }, state.preset.noTradeLogEveryMs);

    setTimeout(() => {
      setStatus("RUNNING");
      pushLog("info", "Range (metrics) RUNNING", { universe: universe.getStatus() });
    }, 250);
  }

  async function stop({ reason = "manual" } = {}) {
    if (state.status === "STOPPED") return;
    setStatus("STOPPING");

    if (timer) clearInterval(timer);
    timer = null;
    if (noTradeTimer) clearInterval(noTradeTimer);
    noTradeTimer = null;

    state.endedAt = now();
    setStatus("STOPPED");
    pushLog("info", `Range (metrics) stopped (${reason})`, {});
    emit("range.status", getState());
  }

  return {
    start,
    stop,
    getState,
  };
}

// backend/src/pullbackTest.js
// Paper engine: MTF pullback (1h context, 15m setup, 5m trigger)
// Universe: Bybit USDT linear perps with market cap > $10M (via CoinMarketCap).

import { atr, pivots, lastClosedCandle, trendFromSwings } from "./ta.js";

function now() {
  return Date.now();
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function fmtNum(x, d = 6) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return Number.isFinite(d) ? n.toFixed(d) : String(n);
}

function makeLog(level, msg, meta) {
  return { t: now(), level, msg, meta };
}

function calcQtyForRisk({ riskUSDT, entry, sl }) {
  const r = Math.abs(entry - sl);
  if (!Number.isFinite(r) || r <= 0) return null;
  return riskUSDT / r; // base qty approx for linear perps
}

function chooseLevelForPullback({ side, px, lvl15, lvl1h, zoneWidth }) {
  // pick the closest relevant level in direction of mean reversion
  const candidates = [];
  if (Number.isFinite(lvl15)) candidates.push(lvl15);
  if (Number.isFinite(lvl1h)) candidates.push(lvl1h);

  if (!candidates.length) return null;

  // for long we prefer support below price; for short resistance above
  let best = null;
  let bestDist = Infinity;
  for (const lv of candidates) {
    const d = Math.abs(px - lv);
    if (!Number.isFinite(d)) continue;

    if (side === "LONG" && lv > px + zoneWidth) continue;
    if (side === "SHORT" && lv < px - zoneWidth) continue;

    if (d < bestDist) {
      bestDist = d;
      best = lv;
    }
  }

  return best;
}

function inZone(px, level, zoneWidth) {
  return Math.abs(px - level) <= zoneWidth;
}

function triggerReclaim({ side, level, prevC, curC, buffer }) {
  // Reclaim: price pokes beyond level then closes back across it.
  if (!prevC || !curC) return false;
  if (side === "LONG") {
    const wasBelow = (prevC.c < level - buffer) || (prevC.l < level - buffer);
    const reclaimed = curC.c > level + buffer;
    const poked = curC.l < level - buffer;
    return reclaimed && (wasBelow || poked);
  }
  // SHORT
  const wasAbove = (prevC.c > level + buffer) || (prevC.h > level + buffer);
  const reclaimed = curC.c < level - buffer;
  const poked = curC.h > level + buffer;
  return reclaimed && (wasAbove || poked);
}

function conservativeExitWithinCandle({ side, candle, sl, tp }) {
  // candle = {h,l}. If both SL and TP touched, return conservative (SL first).
  if (!candle) return null;
  if (side === "LONG") {
    const hitSl = candle.l <= sl;
    const hitTp = candle.h >= tp;
    if (hitSl && hitTp) return "SL";
    if (hitSl) return "SL";
    if (hitTp) return "TP";
    return null;
  }
  const hitSl = candle.h >= sl;
  const hitTp = candle.l <= tp;
  if (hitSl && hitTp) return "SL";
  if (hitSl) return "SL";
  if (hitTp) return "TP";
  return null;
}

export function createPullbackTest({
  universe,
  klines,
  trade,
  logger = console,
  onEvent = () => {},
} = {}) {
  const defaults = {
    mode: "paper",

    // data
    intervals: { tf5: "5", tf15: "15", tf60: "60" },
    candlesLimit: 220,

    // pivots
    pivotLeft: 2,
    pivotRight: 2,

    // zones / triggers
    zoneAtrMult: 0.35,
    triggerBufferAtr5: 0.10,

    // risk & sizing
    riskUSDT: 10,
    minRR1: 0.8,
    minEdgeAfterFees: 0.0015,

    // exits
    tpR: [1.0, 2.0, 3.0],
    weights: [0.4, 0.3, 0.3],
    moveSlToBEAfterTP1: true,

    // scan
    scanPerTick: 4,
    tickMs: 2000,
    noTradeLogEveryMs: 10_000,
    cooldownMs: 60_000,

    // range-mode sensitivity
    rangeEdgeFrac: 0.35,
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
    emit("pullback.log", l);
  }

  function setStatus(next) {
    state.status = next;
    emit("pullback.status", getState());
  }

  function addTrade(t) {
    state.trades = [...state.trades, t].slice(-200);
    emit("pullback.trade", t);
  }

  function setPosition(p) {
    state.position = p;
    emit("pullback.position", p);
  }

  function getState() {
    return {
      ...state,
      mode: state.preset.mode,
    };
  }

  async function computeCandidate(symbol) {
    const p = state.preset;

    const c60 = await klines.getCandles({ symbol, interval: p.intervals.tf60, limit: p.candlesLimit });
    const c15 = await klines.getCandles({ symbol, interval: p.intervals.tf15, limit: p.candlesLimit });
    const c5 = await klines.getCandles({ symbol, interval: p.intervals.tf5, limit: p.candlesLimit });

    if (c60.length < 50 || c15.length < 50 || c5.length < 50) {
      return { ok: false, reason: "not_enough_candles" };
    }

    const cur5 = lastClosedCandle(c5);
    const prev5 = c5.length >= 2 ? c5[c5.length - 2] : null;
    const px = cur5?.c;
    if (!Number.isFinite(px)) return { ok: false, reason: "no_price" };

    const atr15 = atr(c15, 14);
    const atr5 = atr(c5, 14);
    if (!Number.isFinite(atr15) || !Number.isFinite(atr5)) {
      return { ok: false, reason: "no_atr" };
    }

    const piv60 = pivots(c60, p.pivotLeft, p.pivotRight);
    const piv15 = pivots(c15, p.pivotLeft, p.pivotRight);
    const piv5 = pivots(c5, p.pivotLeft, p.pivotRight);

    const trend = trendFromSwings(piv60.highs, piv60.lows);

    // Range boundaries (latest pivot high/low)
    const lastH = piv60.highs.length ? piv60.highs[piv60.highs.length - 1].price : null;
    const lastL = piv60.lows.length ? piv60.lows[piv60.lows.length - 1].price : null;
    const range = (Number.isFinite(lastH) && Number.isFinite(lastL)) ? Math.abs(lastH - lastL) : null;

    let allowedSides = [];
    if (trend === "up") allowedSides = ["LONG"];
    else if (trend === "down") allowedSides = ["SHORT"];
    else allowedSides = ["LONG", "SHORT"];

    // In range, constrain to edges
    if (trend === "range" && Number.isFinite(range) && range > 0) {
      const lowEdge = Math.min(lastH, lastL) + p.rangeEdgeFrac * range;
      const highEdge = Math.max(lastH, lastL) - p.rangeEdgeFrac * range;
      allowedSides = [];
      if (px <= lowEdge) allowedSides.push("LONG");
      if (px >= highEdge) allowedSides.push("SHORT");
      if (!allowedSides.length) {
        return { ok: false, reason: "range_mid" };
      }
    }

    // Pick base levels: nearest relevant pivot from 15m and 1h
    const lvl15Long = piv15.lows.length ? piv15.lows[piv15.lows.length - 1].price : null;
    const lvl15Short = piv15.highs.length ? piv15.highs[piv15.highs.length - 1].price : null;

    const lvl1hLong = piv60.lows.length ? piv60.lows[piv60.lows.length - 1].price : null;
    const lvl1hShort = piv60.highs.length ? piv60.highs[piv60.highs.length - 1].price : null;

    const zoneWidth = atr15 * p.zoneAtrMult;
    const buffer = atr5 * p.triggerBufferAtr5;

    // Build candidates for allowed sides and score by distance to level (closer is better)
    const sideCandidates = [];

    for (const side of allowedSides) {
      const level = chooseLevelForPullback({
        side,
        px,
        lvl15: side === "LONG" ? lvl15Long : lvl15Short,
        lvl1h: side === "LONG" ? lvl1hLong : lvl1hShort,
        zoneWidth,
      });
      if (!Number.isFinite(level)) continue;

      const inZ = inZone(px, level, zoneWidth);
      if (!inZ) {
        sideCandidates.push({ side, level, px, zoneWidth, buffer, trend, score: 10_000 + Math.abs(px - level) });
        continue;
      }

      const trig = triggerReclaim({ side, level, prevC: prev5, curC: cur5, buffer });
      const score = Math.abs(px - level); // smaller is better

      sideCandidates.push({ side, level, px, zoneWidth, buffer, trend, trigger: trig, score });
    }

    if (!sideCandidates.length) return { ok: false, reason: "no_level" };

    // pick best (lowest score), but prefer those in zone
    sideCandidates.sort((a, b) => {
      const az = inZone(a.px, a.level, a.zoneWidth) ? 0 : 1;
      const bz = inZone(b.px, b.level, b.zoneWidth) ? 0 : 1;
      if (az !== bz) return az - bz;
      return a.score - b.score;
    });

    const best = sideCandidates[0];
    const inZ = inZone(best.px, best.level, best.zoneWidth);

    // Compute structural SL using 5m and 15m pivots
    let sl;
    if (best.side === "LONG") {
      const lv5 = piv5.lows.length ? piv5.lows[piv5.lows.length - 1].price : null;
      const base = Math.min(best.level, Number.isFinite(lv5) ? lv5 : best.level);
      sl = base - best.buffer;
    } else {
      const hv5 = piv5.highs.length ? piv5.highs[piv5.highs.length - 1].price : null;
      const base = Math.max(best.level, Number.isFinite(hv5) ? hv5 : best.level);
      sl = base + best.buffer;
    }

    if (!Number.isFinite(sl) || sl === best.px) return { ok: false, reason: "bad_sl" };

    // Targets from swings (preferred), else R-multiples
    const risk = Math.abs(best.px - sl);

    function pickTpFromPivots(side, pivList, entry) {
      // nearest pivot in direction
      if (!Array.isArray(pivList) || !pivList.length) return null;
      const dir = side === "LONG" ? 1 : -1;
      let bestTp = null;
      let bestDist = Infinity;
      for (const pv of pivList) {
        const price = pv.price;
        const d = (price - entry) * dir;
        if (d <= 0) continue;
        if (d < bestDist) {
          bestDist = d;
          bestTp = price;
        }
      }
      return bestTp;
    }

    const piv5Tps = best.side === "LONG" ? piv5.highs : piv5.lows;
    const piv15Tps = best.side === "LONG" ? piv15.highs : piv15.lows;
    const piv60Tps = best.side === "LONG" ? piv60.highs : piv60.lows;

    const tp1 = pickTpFromPivots(best.side, piv5Tps, best.px) ?? (best.side === "LONG" ? best.px + p.tpR[0] * risk : best.px - p.tpR[0] * risk);
    const tp2 = pickTpFromPivots(best.side, piv15Tps, best.px) ?? (best.side === "LONG" ? best.px + p.tpR[1] * risk : best.px - p.tpR[1] * risk);
    const tp3 = pickTpFromPivots(best.side, piv60Tps, best.px) ?? (best.side === "LONG" ? best.px + p.tpR[2] * risk : best.px - p.tpR[2] * risk);

    // basic RR gate on TP1
    const rr1 = Math.abs(tp1 - best.px) / risk;
    const setupDistance = Math.abs(best.px - best.level);
    const edge = Math.abs(tp1 - best.px) - (best.px * p.minEdgeAfterFees);

    return {
      ok: true,
      symbol,
      side: best.side,
      trend: best.trend,
      px: best.px,
      level: best.level,
      zoneWidth: best.zoneWidth,
      trigger: Boolean(best.trigger),
      sl,
      tp1,
      tp2,
      tp3,
      rr1,
      setupDistance,
      edge,
      minEdge: best.px * p.minEdgeAfterFees,
      triggerState: best.trigger ? "armed" : "none",
      candle5: { t: cur5.t, o: cur5.o, h: cur5.h, l: cur5.l, c: cur5.c },
    };
  }

  async function tick() {
    const p = state.preset;

    // universe status
    const uStatus = universe.getStatus();
    state.scan.universeStatus = uStatus;

    const u = universe.getUniverse({ limit: 10 }); // shortlist max 10
    state.scan.universeSize = u.length;

    if (uStatus.status !== "ready" || !u.length) {
      return { ok: false, reason: uStatus.status !== "ready" ? "universe_not_ready" : "universe_empty" };
    }

    if (state.position) {
      // manage position using last closed 5m candle

    if (state.position && state.preset.mode === "demo") {
      try {
        const synced = await trade.sync({ symbol: state.position.symbol });
        const size = Number(synced?.position?.size || 0);
        state.position.sync = synced;
        emit("pullback.position", state.position);
        if (size === 0) {
          const closed = (synced?.closedPnL || [])[0] || null;
          const pnl = Number(closed?.closedPnl || 0);
          const tradeRec = {
            tOpen: state.position.openedAt,
            tClose: now(),
            symbol: state.position.symbol,
            side: state.position.side,
            entry: state.position.entry,
            exit: null,
            reason: "EXCHANGE_CLOSE",
            pnlUSDT: Number.isFinite(pnl) ? pnl : 0,
            mode: state.preset.mode,
          };
          state.stats.trades++;
          if (tradeRec.pnlUSDT >= 0) state.stats.wins++; else state.stats.losses++;
          state.stats.pnlUSDT += tradeRec.pnlUSDT;
          addTrade(tradeRec);
          setPosition(null);
          state.cooldownUntil = now() + p.cooldownMs;
          return { ok: true, action: "demo_closed" };
        }
        return { ok: true, action: "demo_sync" };
      } catch (e) {
        pushLog("warn", `Demo sync failed: ${e?.message || e}`);
        return { ok: false, reason: "demo_sync_failed" };
      }
    }

      const sym = state.position.symbol;
      const c5 = await klines.getCandles({ symbol: sym, interval: p.intervals.tf5, limit: p.candlesLimit });
      const cur5 = lastClosedCandle(c5);
      if (!cur5) return { ok: false, reason: "no_5m" };

      const pos = state.position;

      // check SL/TP for remaining legs
      const legs = pos.legs;
      const candle = cur5;

      // update last seen
      pos.lastCandleT = candle.t;
      pos.lastPrice = candle.c;

      // process TP legs in order
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        if (leg.done) continue;

        const kind = conservativeExitWithinCandle({ side: pos.side, candle, sl: pos.sl, tp: leg.tp });
        if (!kind) continue;

        if (kind === "SL") {
          // close everything at SL
          const exitPrice = pos.sl;
          let pnl = 0;
          for (const lg of legs) {
            if (lg.done) continue;
            const qty = pos.qty * lg.weight;
            pnl += pos.side === "LONG" ? (exitPrice - pos.entry) * qty : (pos.entry - exitPrice) * qty;
            lg.done = true;
            lg.exit = { t: now(), price: exitPrice, reason: "SL" };
          }

          const trade = {
            tOpen: pos.openedAt,
            tClose: now(),
            symbol: pos.symbol,
            side: pos.side,
            entry: pos.entry,
            exit: exitPrice,
            reason: "SL",
            pnlUSDT: pnl,
          };

          state.stats.trades++;
          state.stats.losses++;
          state.stats.pnlUSDT += pnl;

          addTrade(trade);
          pushLog("warn", `SL hit ${pos.side} ${pos.symbol} entry=${fmtNum(pos.entry)} sl=${fmtNum(pos.sl)} pnl=${fmtNum(pnl, 4)}`, trade);

          setPosition(null);
          state.cooldownUntil = now() + p.cooldownMs;
          emit("pullback.status", getState());
          return { ok: true, action: "sl" };
        }

        // TP
        const exitPrice = leg.tp;
        const qty = pos.qty * leg.weight;
        const pnl = pos.side === "LONG" ? (exitPrice - pos.entry) * qty : (pos.entry - exitPrice) * qty;
        leg.done = true;
        leg.exit = { t: now(), price: exitPrice, reason: `TP${i + 1}` };
        state.stats.pnlUSDT += pnl;

        pushLog("info", `TP${i + 1} hit ${pos.side} ${pos.symbol} tp=${fmtNum(exitPrice)} legPnl=${fmtNum(pnl, 4)}`, { symbol: pos.symbol, tp: exitPrice, pnl });

        // After TP1 move SL to BE
        if (i === 0 && p.moveSlToBEAfterTP1) {
          pos.sl = pos.entry;
          pushLog("info", `SL moved to BE for ${pos.symbol}`, { sl: pos.sl });
        }

        // if all legs done -> close trade
        if (legs.every((x) => x.done)) {
          const trade = {
            tOpen: pos.openedAt,
            tClose: now(),
            symbol: pos.symbol,
            side: pos.side,
            entry: pos.entry,
            exit: exitPrice,
            reason: `TP${i + 1}`,
            pnlUSDT: 0,
            legs,
          };

          // compute realized pnl for that trade by summing legs
          let tradePnl = 0;
          for (const lg of legs) {
            const q = pos.qty * lg.weight;
            const ex = lg.exit?.price;
            if (!Number.isFinite(ex)) continue;
            tradePnl += pos.side === "LONG" ? (ex - pos.entry) * q : (pos.entry - ex) * q;
          }
          trade.pnlUSDT = tradePnl;

          state.stats.trades++;
          if (tradePnl >= 0) state.stats.wins++; else state.stats.losses++;

          addTrade(trade);
          pushLog("info", `Position closed ${pos.side} ${pos.symbol} pnl=${fmtNum(tradePnl, 4)}`, trade);

          setPosition(null);
          state.cooldownUntil = now() + p.cooldownMs;
          emit("pullback.status", getState());
          return { ok: true, action: "tp_all" };
        }

        // position remains open after partial TP
        setPosition({ ...pos });
        emit("pullback.status", getState());
        return { ok: true, action: "tp" };
      }

      // no exit this candle
      setPosition({ ...pos });
      return { ok: true, action: "hold" };
    }

    // no position
    if (now() < state.cooldownUntil) {
      return { ok: false, reason: "cooldown" };
    }

    // scan batch
    const reasons = new Map();
    let best = null;

    const startIdx = state.scan.scanIdx;
    const N = u.length;

    for (let k = 0; k < p.scanPerTick; k++) {
      const idx = (startIdx + k) % N;
      const sym = u[idx];

      const c = await computeCandidate(sym);
      if (!c.ok) {
        reasons.set(c.reason, (reasons.get(c.reason) || 0) + 1);
        continue;
      }

      // candidate info
      const key = c.trigger ? 0 : 1;
      const score = key * 1_000_000 + c.rr1 * -1000 + Math.abs(c.px - c.level);

      // prefer trigger-ready and higher rr1 and closer level
      if (!best || score < best._score) {
        best = { ...c, _score: score };
      }

      reasons.set(c.trigger ? "in_zone_no_trigger" : "out_of_zone", (reasons.get(c.trigger ? "in_zone_no_trigger" : "out_of_zone") || 0) + 1);
    }

    state.scan.scanIdx = (startIdx + p.scanPerTick) % N;
    state.scan.lastScanAt = now();
    state.scan.lastCandidate = best ? {
      symbol: best.symbol,
      side: best.side,
      trend: best.trend,
      px: best.px,
      level: best.level,
      zoneWidth: best.zoneWidth,
      trigger: best.trigger,
      rr1: best.rr1,
      setupDistance: best.setupDistance,
      threshold: best.zoneWidth,
      triggerState: best.triggerState,
      edge: best.edge,
      minEdge: best.minEdge,
      sl: best.sl,
      tp1: best.tp1,
      tp2: best.tp2,
      tp3: best.tp3,
    } : null;

    if (!best) {
      return { ok: false, reason: "no_candidate", reasons: Object.fromEntries(reasons.entries()) };
    }

    if (!inZone(best.px, best.level, best.zoneWidth)) {
      return { ok: false, reason: "not_in_zone", candidate: state.scan.lastCandidate };
    }

    if (!best.trigger) {
      return { ok: false, reason: "no_trigger", candidate: state.scan.lastCandidate };
    }

    if (best.rr1 < p.minRR1) {
      return { ok: false, reason: "rr_too_low", candidate: state.scan.lastCandidate, rr1: best.rr1 };
    }
    if (best.edge < best.minEdge) {
      return { ok: false, reason: "edge_too_low", candidate: state.scan.lastCandidate, edge: best.edge, minEdge: best.minEdge };
    }

    const qty = calcQtyForRisk({ riskUSDT: p.riskUSDT, entry: best.px, sl: best.sl });
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, reason: "bad_qty", candidate: state.scan.lastCandidate };
    }

    // open position
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
      level: best.level,
      zoneWidth: best.zoneWidth,
      sl: best.sl,
      qty,
      rr1: best.rr1,
      legs,
      trend: best.trend,
    };

    if (["demo", "real"].includes(state.preset.mode)) {
      try {
        if (!trade || !trade.enabled()) return { ok: false, reason: "trade_disabled" };
        const entryQty = qty;
        const tpQtys = [p.weights[0], p.weights[1], p.weights[2]].map((w) => entryQty * w);
        const bybitSide = best.side === "LONG" ? "Buy" : "Sell";
        const execRes = await trade.openPosition({
          symbol: best.symbol,
          side: bybitSide,
          qty: entryQty,
          slPrice: best.sl,
          tps: [
            { price: best.tp1, qty: tpQtys[0] },
            { price: best.tp2, qty: tpQtys[1] },
            { price: best.tp3, qty: tpQtys[2] },
          ],
        });
        setPosition({ ...pos, mode: state.preset.mode, exec: execRes });
        pushLog("info", `OPEN live ${pos.side} ${pos.symbol} entry=${fmtNum(pos.entry)} sl=${fmtNum(pos.sl)}`, { execRes });
      } catch (e) {
        pushLog("error", `Live entry failed: ${e?.message || e}`, { symbol: pos.symbol });
        return { ok: false, reason: "live_entry_failed" };
      }
    } else {
      setPosition(pos);
      pushLog("info", `OPEN ${pos.side} ${pos.symbol} entry=${fmtNum(pos.entry)} sl=${fmtNum(pos.sl)} rr1=${fmtNum(pos.rr1, 2)}`, pos);
    }
    emit("pullback.status", getState());

    return { ok: true, action: "open", pos };
  }

  async function start({ preset, mode } = {}) {
    if (state.status === "RUNNING" || state.status === "STARTING") return;

    state.preset = { ...defaults, ...(preset && typeof preset === "object" ? preset : {}) };
    if (["demo", "real"].includes(mode)) state.preset.mode = mode;
    state.startedAt = now();
    state.endedAt = null;
    state.cooldownUntil = 0;
    state.position = null;
    state.trades = [];
    state.logs = [];
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0 };

    setStatus("STARTING");
    pushLog("info", "Pullback test starting...", { preset: state.preset });

    // Ensure universe refresh is underway
    universe.refresh?.().catch(() => {});

    // Start loop
    timer = setInterval(() => {
      tick().catch((e) => {
        logger?.warn?.({ err: e }, "pullback tick failed");
      });
    }, state.preset.tickMs);

    // No-trade explanation loop
    noTradeTimer = setInterval(() => {
      if (state.status !== "RUNNING") return;
      if (state.position) return;
      const c = state.scan.lastCandidate;
      const uStatus = state.scan.universeStatus;

      const reasons = [];
      if (uStatus?.status !== "ready") reasons.push(`universe=${uStatus?.status}`);
      if (c) {
        reasons.push(`setupDistance=${fmtNum(c.setupDistance, 6)} threshold=${fmtNum(c.threshold ?? c.zoneWidth, 6)}`);
        reasons.push(`triggerState=${c.triggerState || (c.trigger ? "armed" : "none")}`);
        reasons.push(`edge=${fmtNum(c.edge, 6)} minEdge=${fmtNum(c.minEdge, 6)}`);
      } else {
        reasons.push("no_candidate");
      }

      const cooldownRemainingMs = Math.max(0, state.cooldownUntil - now());
      reasons.push(`cooldownRemainingMs=${cooldownRemainingMs}`);
      pushLog("info", `No entry: ${reasons.slice(0, 3).join(" | ")}`, { candidate: c, universe: uStatus, cooldownRemainingMs });
    }, state.preset.noTradeLogEveryMs);

    // Promote to RUNNING asynchronously
    setTimeout(() => {
      setStatus("RUNNING");
      pushLog("info", "Pullback test RUNNING", { universe: universe.getStatus?.() });
    }, 300);
  }

  async function stop({ reason = "manual" } = {}) {
    if (state.status === "STOPPED" || state.status === "STOPPING") return;
    setStatus("STOPPING");

    if (timer) clearInterval(timer);
    if (noTradeTimer) clearInterval(noTradeTimer);
    timer = null;
    noTradeTimer = null;

    state.endedAt = now();
    setStatus("STOPPED");
    pushLog("info", `Pullback test stopped (${reason})`, {});
  }

  return {
    start,
    stop,
    getState,
  };
}

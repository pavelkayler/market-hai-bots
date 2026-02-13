import { MOMENTUM_STATUS, SIDE, SYMBOL_STATE } from './momentumTypes.js';
import { calcChange, calcTpSl, normalizeMomentumConfig, roundByTickForSide } from './momentumUtils.js';

export function createMomentumInstance({ id, config, marketData, sqlite, tradeExecutor = null, logger = console }) {
  const cfg = normalizeMomentumConfig(config);
  const symbols = new Map();
  const logs = [];
  const skipLogAt = new Map();
  const stats = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, signals1m: 0, signals5m: 0 };
  const signalViewBySymbol = new Map();
  let status = MOMENTUM_STATUS.RUNNING;
  const startedAt = Date.now();

  function log(msg, extra = {}) {
    const line = { ts: Date.now(), msg, ...extra };
    logs.unshift(line);
    if (logs.length > 150) logs.pop();
  }

  function logSkipReason(symbol, side, reason, extra = {}, throttleMs = 5000) {
    const key = `${symbol}:${side}:${reason}`;
    const now = Date.now();
    const prev = Number(skipLogAt.get(key) || 0);
    if ((now - prev) < throttleMs) return;
    skipLogAt.set(key, now);
    log(reason, { symbol, side, ...extra });
  }

  function stateFor(symbol) {
    if (!symbols.has(symbol)) {
      symbols.set(symbol, {
        state: SYMBOL_STATE.IDLE,
        cooldownUntil: 0,
        pending: null,
        pos: null,
        holdCount: { LONG: 0, SHORT: 0 },
        lastLastPrice: null,
      });
    }
    return symbols.get(symbol);
  }

  function getTriggerPrice({ side, signalPrice, tickSize }) {
    const offsetFactor = 1 + (Number(cfg.entryOffsetPct || 0) / 100);
    const rawPrice = Number(signalPrice) * offsetFactor;
    return roundByTickForSide(rawPrice, tickSize, side);
  }

  function createTrigger(symbol, side, snap, nowMs, st) {
    const entrySource = String(cfg.entryPriceSource || 'LAST').toUpperCase();
    const sourcePrice = entrySource === 'MARK' ? snap.markPrice : snap.lastPrice;
    const triggerPrice = getTriggerPrice({ side, signalPrice: sourcePrice, tickSize: snap.tickSize });
    if (!(triggerPrice > 0)) return false;
    st.state = SYMBOL_STATE.TRIGGER_PENDING;
    st.pending = { side, triggerPrice, createdAtMs: nowMs, holdProgress: cfg.holdSeconds, trendProgress: cfg.trendConfirmSeconds, entryOffsetPct: cfg.entryOffsetPct, lastPriceAtTrigger: snap.lastPrice, markPriceAtTrigger: snap.markPrice };
    st.holdCount.LONG = 0;
    st.holdCount.SHORT = 0;
    log('trigger created', { symbol, side, triggerPrice, markPrice: snap.markPrice, lastPrice: snap.lastPrice, entryPriceSource: entrySource });
    return true;
  }

  function crossed(lastPrev, lastNow, triggerPrice) {
    if (!(Number.isFinite(lastPrev) && Number.isFinite(lastNow) && Number.isFinite(triggerPrice))) return false;
    if (lastNow === triggerPrice) return true;
    return (lastPrev < triggerPrice && lastNow >= triggerPrice) || (lastPrev > triggerPrice && lastNow <= triggerPrice);
  }

  async function openPosition(symbol, st, snap, ts) {
    const p = st.pending;
    if (!p) return;
    const tpSl = calcTpSl({ side: p.side, entryPrice: p.triggerPrice, tpRoiPct: cfg.tpRoiPct, slRoiPct: cfg.slRoiPct, leverage: cfg.leverage });
    let actualEntryPrice = p.triggerPrice;
    if (cfg.mode !== 'paper' && tradeExecutor?.enabled?.()) {
      const side = p.side === SIDE.LONG ? 'Buy' : 'Sell';
      const qty = (cfg.marginUsd * cfg.leverage) / Math.max(1e-9, p.triggerPrice);
      try {
        const res = await tradeExecutor.openPosition({ symbol, side, qty, slPrice: tpSl.slPrice, leverage: cfg.leverage, priceHint: snap.lastPrice });
        actualEntryPrice = Number(res?.avgPrice || res?.entryPrice || p.triggerPrice);
      } catch (err) {
        log('entry execution failed', { symbol, side: p.side, error: String(err?.message || err) });
        return;
      }
    }
    st.state = SYMBOL_STATE.IN_POSITION;
    st.pos = { ...p, entryPrice: p.triggerPrice, actualEntryPrice, triggerPrice: p.triggerPrice, ...tpSl, openedAt: ts };
    st.pending = null;
    log('trigger filled', { symbol, side: st.pos.side, triggerPrice: st.pos.triggerPrice, actualEntryPrice });
  }

  function saveManualCancelTrade(symbol, pending, ts, outcome) {
    sqlite.saveTrade({
      instanceId: id,
      mode: cfg.mode,
      symbol,
      side: pending.side,
      windowMinutes: cfg.windowMinutes,
      priceThresholdPct: cfg.priceThresholdPct,
      oiThresholdPct: cfg.oiThresholdPct,
      turnover24hMin: cfg.turnover24hMin,
      vol24hMin: cfg.vol24hMin,
      leverage: cfg.leverage,
      marginUsd: cfg.marginUsd,
      entryTs: pending.createdAtMs,
      triggerPrice: pending.triggerPrice,
      entryPrice: pending.triggerPrice,
      actualEntryPrice: null,
      exitTs: ts,
      exitPrice: pending.triggerPrice,
      outcome,
      pnlUsd: 0,
      feesUsd: 0,
      durationSec: Math.max(0, Math.round((ts - pending.createdAtMs) / 1000)),
      entryOffsetPct: cfg.entryOffsetPct,
      turnoverSpikePct: cfg.turnoverSpikePct,
      baselineFloorUSDT: cfg.baselineFloorUSDT,
      holdSeconds: cfg.holdSeconds,
      trendConfirmSeconds: cfg.trendConfirmSeconds,
      oiMaxAgeSec: cfg.oiMaxAgeSec,
      lastPriceAtTrigger: pending.lastPriceAtTrigger ?? null,
      markPriceAtTrigger: pending.markPriceAtTrigger ?? null,
    });
  }

  function cancelEntry(symbol, { ts = Date.now(), outcome = 'MANUAL_CANCEL', logMessage = 'entry cancelled' } = {}) {
    const st = stateFor(symbol);
    if (st.state !== SYMBOL_STATE.TRIGGER_PENDING || !st.pending) return { ok: false, reason: 'NOT_PENDING' };
    const pending = st.pending;
    st.pending = null;
    st.state = SYMBOL_STATE.IDLE;
    log(logMessage, { symbol, side: pending.side, outcome });
    saveManualCancelTrade(symbol, pending, ts, outcome);
    return { ok: true };
  }

  function getLongTurnoverGate(symbol) {
    const requiredMultiplier = 1 + (Number(cfg.turnoverSpikePct || 0) / 100);
    const gate = marketData.getTurnoverGate?.(symbol, cfg.windowMinutes) || { ready: false };
    const prev = Number(gate.prevTurnoverUSDT || 0);
    const median = Number(gate.medianTurnoverUSDT || 0);
    const cur = Number(gate.curTurnoverUSDT || 0);
    const baseline = Math.max(prev, median, Number(cfg.baselineFloorUSDT || 0));
    const passed = gate.ready && cur >= baseline * requiredMultiplier;
    return { gate, prev, median, cur, baseline, requiredMultiplier, passed };
  }

  function saveSignalBase(base) {
    sqlite.saveSignal?.({
      ...base,
      entryOffsetPct: cfg.entryOffsetPct,
      turnoverSpikePct: cfg.turnoverSpikePct,
      baselineFloorUSDT: cfg.baselineFloorUSDT,
      holdSeconds: cfg.holdSeconds,
      trendConfirmSeconds: cfg.trendConfirmSeconds,
      oiMaxAgeSec: cfg.oiMaxAgeSec,
    });
  }

  async function onTick({ ts, sec }, eligibleSymbols) {
    if (status !== MOMENTUM_STATUS.RUNNING) return;
    const windowSec = cfg.windowMinutes * 60;
    let entries = 0;
    for (const symbol of eligibleSymbols) {
      const snap = marketData.getSnapshot(symbol);
      if (!snap || !(snap.markPrice > 0 && snap.lastPrice > 0 && snap.oiValue > 0)) continue;
      const prev = marketData.getAtWindow(symbol, sec - windowSec);
      if (!prev) {
        saveSignalBase({ instanceId: id, symbol, side: null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap.markPrice, markPrev: null, lastNow: snap.lastPrice, lastPrev: null, oiNow: snap.oiValue, oiPrev: null, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NO_PREV_CANDLE' });
        continue;
      }
      const st = stateFor(symbol);
      const prevLast = st.lastLastPrice;
      st.lastLastPrice = snap.lastPrice;

      if (st.state === SYMBOL_STATE.TRIGGER_PENDING && st.pending) {
        if (crossed(prevLast, snap.lastPrice, st.pending.triggerPrice)) await openPosition(symbol, st, snap, ts);
      }

      if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) {
        const p = st.pos;
        const tpHit = (p.side === SIDE.LONG && snap.markPrice >= p.tpPrice) || (p.side === SIDE.SHORT && snap.markPrice <= p.tpPrice);
        const slHit = (p.side === SIDE.LONG && snap.markPrice <= p.slPrice) || (p.side === SIDE.SHORT && snap.markPrice >= p.slPrice);
        if (tpHit || slHit) {
          const exitPrice = snap.markPrice;
          const dir = p.side === SIDE.LONG ? 1 : -1;
          const qty = (cfg.marginUsd * cfg.leverage) / p.entryPrice;
          const pnl = (exitPrice - p.entryPrice) * qty * dir;
          const fees = qty * (p.entryPrice + exitPrice) * 0.0002;
          const net = pnl - fees;
          stats.trades += 1;
          stats.pnl += net;
          stats.fees += fees;
          if (net >= 0) stats.wins += 1; else stats.losses += 1;
          sqlite.saveTrade({ instanceId: id, mode: cfg.mode, symbol, side: p.side, windowMinutes: cfg.windowMinutes, priceThresholdPct: cfg.priceThresholdPct, oiThresholdPct: cfg.oiThresholdPct, turnover24hMin: cfg.turnover24hMin, vol24hMin: cfg.vol24hMin, leverage: cfg.leverage, marginUsd: cfg.marginUsd, entryTs: p.createdAtMs, triggerPrice: p.triggerPrice, entryPrice: p.entryPrice, actualEntryPrice: p.actualEntryPrice, exitTs: ts, exitPrice, outcome: tpHit ? 'TP' : 'SL', pnlUsd: net, feesUsd: fees, durationSec: Math.round((ts - p.openedAt) / 1000), entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec, lastPriceAtTrigger: p.lastPriceAtTrigger ?? null, markPriceAtTrigger: p.markPriceAtTrigger ?? null });
          st.state = SYMBOL_STATE.COOLDOWN;
          st.cooldownUntil = ts + cfg.cooldownMinutes * 60_000;
          st.pos = null;
        }
      }

      if (st.state === SYMBOL_STATE.COOLDOWN && ts >= st.cooldownUntil) st.state = SYMBOL_STATE.IDLE;
      if (st.state === SYMBOL_STATE.TRIGGER_PENDING || st.state === SYMBOL_STATE.IN_POSITION) {
        saveSignalBase({ instanceId: id, symbol, side: st.pending?.side || st.pos?.side || null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'SYMBOL_BUSY' });
        continue;
      }
      if (entries >= cfg.maxNewEntriesPerTick) continue;

      const priceChange = calcChange(snap.lastPrice, prev.lastPrice);
      const oiChange = calcChange(snap.oiValue, prev.oiValue);
      if (priceChange === null || oiChange === null) continue;
      const oiAgeSec = Number(marketData.getOiAgeSec?.(symbol));
      const oiFresh = oiAgeSec <= cfg.oiMaxAgeSec;
      signalViewBySymbol.set(symbol, { symbol, ts, markPrice: snap.markPrice, lastPrice: snap.lastPrice, priceChange, oiValueNow: snap.oiValue, oiChange });

      const sideCandidates = [];
      if (cfg.directionMode === 'LONG' || cfg.directionMode === 'BOTH') sideCandidates.push(SIDE.LONG);
      if (cfg.directionMode === 'SHORT' || cfg.directionMode === 'BOTH') sideCandidates.push(SIDE.SHORT);

      for (const side of sideCandidates) {
        if (entries >= cfg.maxNewEntriesPerTick) break;
        const priceOk = side === SIDE.LONG ? priceChange >= (cfg.priceThresholdPct / 100) : priceChange <= -(cfg.priceThresholdPct / 100);
        const oiOk = side === SIDE.LONG ? oiChange >= (cfg.oiThresholdPct / 100) : oiChange <= -(cfg.oiThresholdPct / 100);
        const trendOk = marketData.getTrendOk?.(symbol, cfg.trendConfirmSeconds, side) || false;
        if (!oiFresh) {
          st.holdCount[side] = 0;
          logSkipReason(symbol, side, 'OI_STALE', { oiAgeSec });
          saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'OI_STALE', oiAgeSec });
          continue;
        }
        if (!trendOk) {
          st.holdCount[side] = 0;
          saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'TREND_FAIL' });
          continue;
        }

        let turnoverOk = true;
        let turnover = null;
        if (side === SIDE.LONG) {
          turnover = getLongTurnoverGate(symbol);
          turnoverOk = turnover.passed;
          if (!turnoverOk) {
            st.holdCount[side] = 0;
            saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'TURNOVER_GATE_FAIL', prevTurnoverUSDT: turnover.prev, curTurnoverUSDT: turnover.cur, medianTurnoverUSDT: turnover.median, turnoverBaselineUSDT: turnover.baseline, turnoverGatePassed: 0 });
            continue;
          }
        }

        const allOk = priceOk && oiOk && trendOk && oiFresh && turnoverOk;
        st.holdCount[side] = allOk ? (st.holdCount[side] + 1) : 0;
        if (allOk && st.holdCount[side] < cfg.holdSeconds) {
          logSkipReason(symbol, side, 'HOLD_NOT_MET', { hold: st.holdCount[side], holdSeconds: cfg.holdSeconds }, 2000);
          saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'HOLD_NOT_MET' });
        }
        if (st.holdCount[side] >= cfg.holdSeconds && createTrigger(symbol, side, snap, ts, st)) {
          entries += 1;
          if (crossed(prevLast, snap.lastPrice, st.pending?.triggerPrice)) await openPosition(symbol, st, snap, ts);
          break;
        }
      }
    }
  }

  function getSnapshot() {
    const openPositions = [];
    const pendingOrders = [];
    let cooldownCount = 0;
    for (const [symbol, st] of symbols.entries()) {
      if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) openPositions.push({ symbol, ...st.pos });
      if (st.state === SYMBOL_STATE.TRIGGER_PENDING && st.pending) pendingOrders.push({ symbol, ...st.pending, ageSec: Math.floor((Date.now() - st.pending.createdAtMs) / 1000) });
      if (st.state === SYMBOL_STATE.COOLDOWN) cooldownCount += 1;
    }
    const signalView = [...signalViewBySymbol.values()].sort((a, b) => b.ts - a.ts).slice(0, 30);
    return { id, config: cfg, status, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), stats, openPositions, pendingOrders, cooldownCount, logs: logs.slice(0, 50), signalView };
  }

  return {
    id,
    onTick,
    stop: () => { status = MOMENTUM_STATUS.STOPPED; },
    cancelEntry,
    getSnapshot,
    getLight: () => ({ id, status, mode: cfg.mode, direction: cfg.directionMode, windowMinutes: cfg.windowMinutes, entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), trades: stats.trades, pnl: stats.pnl, fees: stats.fees, openPositionsCount: getSnapshot().openPositions.length, signals1m: stats.signals1m, signals5m: stats.signals5m }),
  };
}

import { MOMENTUM_STATUS, SIDE, SYMBOL_STATE } from './momentumTypes.js';
import { calcChange, calcTpSl, normalizeMomentumConfig } from './momentumUtils.js';

export function createMomentumInstance({ id, config, marketData, sqlite, logger = console }) {
  const cfg = normalizeMomentumConfig(config);
  const symbols = new Map();
  const logs = [];
  const stats = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, signals1m: 0, signals5m: 0 };
  let status = MOMENTUM_STATUS.RUNNING;
  const startedAt = Date.now();

  function log(msg, extra = {}) {
    const line = { ts: Date.now(), msg, ...extra };
    logs.unshift(line);
    if (logs.length > 150) logs.pop();
  }

  function stateFor(symbol) {
    if (!symbols.has(symbol)) symbols.set(symbol, { state: SYMBOL_STATE.IDLE, cooldownUntil: 0, pending: null, pos: null });
    return symbols.get(symbol);
  }

  function tryEnter(symbol, side, snap, nowMs) {
    const st = stateFor(symbol);
    if (st.state === SYMBOL_STATE.IN_POSITION || st.state === SYMBOL_STATE.ORDER_PENDING) return false;
    if (st.cooldownUntil > nowMs) return false;
    st.state = SYMBOL_STATE.ORDER_PENDING;
    st.pending = { side, entryPrice: snap.markPrice, placedAt: nowMs };
    log('entry pending', { symbol, side, entryPrice: snap.markPrice });
    return true;
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
      entryTs: pending.placedAt,
      entryPrice: pending.entryPrice,
      exitTs: ts,
      exitPrice: pending.entryPrice,
      outcome,
      pnlUsd: 0,
      feesUsd: 0,
      durationSec: Math.max(0, Math.round((ts - pending.placedAt) / 1000)),
    });
  }

  function cancelEntry(symbol, { ts = Date.now(), outcome = 'MANUAL_CANCEL', logMessage = 'entry cancelled' } = {}) {
    const st = stateFor(symbol);
    if (st.state !== SYMBOL_STATE.ORDER_PENDING || !st.pending) return { ok: false, reason: 'NOT_PENDING' };
    const pending = st.pending;
    st.pending = null;
    st.state = SYMBOL_STATE.IDLE;
    log(logMessage, { symbol, side: pending.side, outcome });
    saveManualCancelTrade(symbol, pending, ts, outcome);
    return { ok: true };
  }

  function cancelAllPending({ ts = Date.now(), outcome = 'MANUAL_CANCEL', logMessage = 'all pending entries cancelled' } = {}) {
    let cancelled = 0;
    for (const [symbol, st] of symbols.entries()) {
      if (st.state === SYMBOL_STATE.ORDER_PENDING && st.pending) {
        const pending = st.pending;
        st.pending = null;
        st.state = SYMBOL_STATE.IDLE;
        saveManualCancelTrade(symbol, pending, ts, outcome);
        cancelled += 1;
      }
    }
    if (cancelled > 0) log(logMessage, { cancelled, outcome });
    return cancelled;
  }

  function onTick({ ts, sec }, eligibleSymbols) {
    if (status !== MOMENTUM_STATUS.RUNNING) return;
    const windowSec = cfg.windowMinutes * 60;
    let entries = 0;
    for (const symbol of eligibleSymbols) {
      const snap = marketData.getSnapshot(symbol);
      if (!snap || !(snap.markPrice > 0 && snap.openInterest > 0)) continue;
      const prev = marketData.getAtWindow(symbol, sec - windowSec);
      if (!prev) continue;
      const priceChange = calcChange(snap.markPrice, prev.markPrice);
      const oiChange = calcChange(snap.openInterest, prev.openInterest);
      if (priceChange === null || oiChange === null) continue;

      const st = stateFor(symbol);
      if (st.state === SYMBOL_STATE.ORDER_PENDING && st.pending) {
        const hit = (st.pending.side === SIDE.LONG && snap.markPrice <= st.pending.entryPrice) || (st.pending.side === SIDE.SHORT && snap.markPrice >= st.pending.entryPrice);
        if (hit) {
          const tpSl = calcTpSl({ side: st.pending.side, entryPrice: st.pending.entryPrice, tpRoiPct: cfg.tpRoiPct, slRoiPct: cfg.slRoiPct, leverage: cfg.leverage });
          st.state = SYMBOL_STATE.IN_POSITION;
          st.pos = { ...st.pending, ...tpSl, openedAt: ts };
          st.pending = null;
          log('filled', { symbol, side: st.pos.side });
        }
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
          sqlite.saveTrade({ instanceId: id, mode: cfg.mode, symbol, side: p.side, windowMinutes: cfg.windowMinutes, priceThresholdPct: cfg.priceThresholdPct, oiThresholdPct: cfg.oiThresholdPct, turnover24hMin: cfg.turnover24hMin, vol24hMin: cfg.vol24hMin, leverage: cfg.leverage, marginUsd: cfg.marginUsd, entryTs: p.placedAt, entryPrice: p.entryPrice, exitTs: ts, exitPrice, outcome: tpHit ? 'TP' : 'SL', pnlUsd: net, feesUsd: fees, durationSec: Math.round((ts - p.openedAt) / 1000) });
          st.state = SYMBOL_STATE.COOLDOWN;
          st.cooldownUntil = ts + cfg.cooldownMinutes * 60_000;
          st.pos = null;
        }
      }

      if (st.state === SYMBOL_STATE.COOLDOWN && ts >= st.cooldownUntil) st.state = SYMBOL_STATE.IDLE;

      const longOk = priceChange >= (cfg.priceThresholdPct / 100) && oiChange >= (cfg.oiThresholdPct / 100);
      const shortOk = priceChange <= -(cfg.priceThresholdPct / 100) && oiChange <= -(cfg.oiThresholdPct / 100);
      if (entries >= cfg.maxNewEntriesPerTick) continue;

      const signalCandidates = [];
      if ((cfg.directionMode === 'LONG' || cfg.directionMode === 'BOTH') && longOk) signalCandidates.push(SIDE.LONG);
      if ((cfg.directionMode === 'SHORT' || cfg.directionMode === 'BOTH') && shortOk) signalCandidates.push(SIDE.SHORT);

      for (const side of signalCandidates) {
        if (entries >= cfg.maxNewEntriesPerTick) break;
        if (st.state === SYMBOL_STATE.ORDER_PENDING || st.state === SYMBOL_STATE.IN_POSITION) {
          log('SKIP SYMBOL_BUSY', { symbol, side, symbolState: st.state });
          sqlite.saveSignal?.({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, oiNow: snap.openInterest, oiPrev: prev.openInterest, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'SYMBOL_BUSY' });
          continue;
        }
        if (tryEnter(symbol, side, snap, ts)) entries += 1;
      }
    }
  }

  function getSnapshot() {
    const openPositions = [];
    const pendingOrders = [];
    let cooldownCount = 0;
    for (const [symbol, st] of symbols.entries()) {
      if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) openPositions.push({ symbol, ...st.pos });
      if (st.state === SYMBOL_STATE.ORDER_PENDING && st.pending) pendingOrders.push({ symbol, ...st.pending });
      if (st.state === SYMBOL_STATE.COOLDOWN) cooldownCount += 1;
    }
    return { id, config: cfg, status, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), stats, openPositions, pendingOrders, cooldownCount, logs: logs.slice(0, 50) };
  }

  return {
    id,
    onTick,
    stop: () => {
      cancelAllPending({ ts: Date.now(), outcome: 'MANUAL_CANCEL', logMessage: 'stop cancelled pending entries' });
      status = MOMENTUM_STATUS.STOPPED;
    },
    cancelEntry,
    getSnapshot,
    getLight: () => ({ id, status, mode: cfg.mode, direction: cfg.directionMode, windowMinutes: cfg.windowMinutes, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), trades: stats.trades, pnl: stats.pnl, fees: stats.fees, openPositionsCount: getSnapshot().openPositions.length, signals1m: stats.signals1m, signals5m: stats.signals5m }),
  };
}

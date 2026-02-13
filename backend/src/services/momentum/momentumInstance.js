import { MOMENTUM_STATUS, SIDE, SYMBOL_STATE } from './momentumTypes.js';
import { calcChange, calcTpSl, normalizeMomentumConfig, roundByTickForSide } from './momentumUtils.js';

const TPSL_STATUS = {
  PENDING: 'PENDING',
  ATTACHED: 'ATTACHED',
  UNKNOWN: 'UNKNOWN',
};

export function createMomentumInstance({ id, config, marketData, sqlite, tradeExecutor = null, logger = console, isolatedPreflight = null }) {
  const cfg = normalizeMomentumConfig(config);
  const symbols = new Map();
  const logs = [];
  const skipLogAt = new Map();
  const isolatedReadyBySymbol = new Map();
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
    const key = `${symbol}:${side || 'NA'}:${reason}`;
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

  async function ensureIsolatedOnFirstTrade(symbol) {
    if (cfg.mode === 'paper' || !tradeExecutor?.enabled?.()) return { ok: true, skipped: true };
    if (isolatedReadyBySymbol.get(symbol) === true) return { ok: true, cached: true };
    const out = await tradeExecutor.ensureIsolated?.({ symbol });
    if (out?.ok) isolatedReadyBySymbol.set(symbol, true);
    return out || { ok: false, error: 'ISOLATED_CHECK_FAILED' };
  }

  async function syncEntryFill({ symbol, side, entryOrderId }) {
    const timeoutMs = 4000;
    const intervalMs = 300;
    const started = Date.now();
    while ((Date.now() - started) <= timeoutMs) {
      try {
        if (entryOrderId && tradeExecutor?.getOrderById) {
          const order = await tradeExecutor.getOrderById({ symbol, orderId: entryOrderId });
          const avgPrice = Number(order?.avgPrice || 0);
          const qty = Number(order?.cumExecQty || order?.qty || 0);
          if (avgPrice > 0) return { entryPriceActual: avgPrice, entryQtyActual: qty > 0 ? qty : null, entryFillTs: Date.now() };
        }
        if (entryOrderId && tradeExecutor?.getExecutionsByOrderId) {
          const rows = await tradeExecutor.getExecutionsByOrderId({ symbol, orderId: entryOrderId });
          const first = Array.isArray(rows) ? rows.find((x) => Number(x?.execPrice || 0) > 0) : null;
          if (first) return { entryPriceActual: Number(first.execPrice), entryQtyActual: Number(first.execQty || 0) || null, entryFillTs: Number(first.execTime || Date.now()) };
        }
        if (tradeExecutor?.getPosition) {
          const pos = await tradeExecutor.getPosition({ symbol });
          const posSide = String(pos?.side || '').toUpperCase();
          if ((side === SIDE.LONG && posSide === 'BUY') || (side === SIDE.SHORT && posSide === 'SELL')) {
            const avg = Number(pos?.avgPrice || 0);
            const qty = Number(pos?.size || 0);
            if (avg > 0) return { entryPriceActual: avg, entryQtyActual: qty > 0 ? qty : null, entryFillTs: Date.now() };
          }
        }
      } catch (err) {
        logger?.warn?.({ err, symbol, entryOrderId }, 'momentum fill sync polling failed');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    log('FILL_SYNC_TIMEOUT', { symbol, entryOrderId });
    return { entryPriceActual: null, entryQtyActual: null, entryFillTs: null };
  }

  async function syncTpSlAttachment({ symbol, side, pos }) {
    const closeSide = side === SIDE.LONG ? 'Sell' : 'Buy';
    const timeoutMs = 3500;
    const intervalMs = 250;
    const started = Date.now();
    while ((Date.now() - started) <= timeoutMs) {
      try {
        const orders = await tradeExecutor.getOpenOrders?.({ symbol });
        const rows = Array.isArray(orders) ? orders : [];
        const reduceRows = rows.filter((x) => x?.reduceOnly && String(x?.side || '').toLowerCase() === closeSide.toLowerCase());
        if (reduceRows.length > 0) {
          pos.tpSlStatus = TPSL_STATUS.ATTACHED;
          pos.tpOrderId = pos.tpOrderId || reduceRows[0]?.orderId || null;
          if (!pos.slOrderId && reduceRows.length > 1) pos.slOrderId = reduceRows[1]?.orderId || null;
          return;
        }
      } catch (err) {
        logger?.warn?.({ err, symbol }, 'momentum tp/sl sync polling failed');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    pos.tpSlStatus = TPSL_STATUS.UNKNOWN;
    log('TPSL_SYNC_TIMEOUT', { symbol, side });
  }

  async function openPosition(symbol, st, snap, ts) {
    const p = st.pending;
    if (!p) return;
    const isolated = await ensureIsolatedOnFirstTrade(symbol);
    if (!isolated?.ok) {
      log('entry blocked: isolated required', { symbol, error: isolated?.error || 'unknown' });
      return;
    }
    const tpSl = calcTpSl({ side: p.side, entryPrice: p.triggerPrice, tpRoiPct: cfg.tpRoiPct, slRoiPct: cfg.slRoiPct, leverage: cfg.leverage });
    let actualEntryPrice = p.triggerPrice;
    let entryOrderId = null;
    let tpOrderId = null;
    let slOrderId = null;
    let entryPriceActual = null;
    let entryQtyActual = null;
    let entryFillTs = null;
    let tpSlStatus = TPSL_STATUS.PENDING;

    if (cfg.mode !== 'paper' && tradeExecutor?.enabled?.()) {
      const side = p.side === SIDE.LONG ? 'Buy' : 'Sell';
      const qty = (cfg.marginUsd * cfg.leverage) / Math.max(1e-9, p.triggerPrice);
      try {
        const res = await tradeExecutor.openPosition({ symbol, side, qty, slPrice: tpSl.slPrice, leverage: cfg.leverage, priceHint: snap.lastPrice });
        entryOrderId = res?.entryOrderId || null;
        tpOrderId = Array.isArray(res?.tpOrderIds) ? (res.tpOrderIds[0] || null) : null;
        actualEntryPrice = Number(res?.avgPrice || res?.entryPrice || p.triggerPrice);
        entryPriceActual = Number.isFinite(actualEntryPrice) && actualEntryPrice > 0 ? actualEntryPrice : null;
        const fill = await syncEntryFill({ symbol, side: p.side, entryOrderId });
        if (fill.entryPriceActual > 0) {
          entryPriceActual = fill.entryPriceActual;
          actualEntryPrice = fill.entryPriceActual;
          entryQtyActual = fill.entryQtyActual;
          entryFillTs = fill.entryFillTs;
        }
      } catch (err) {
        log('entry execution failed', { symbol, side: p.side, error: String(err?.message || err) });
        return;
      }
    }

    st.state = SYMBOL_STATE.IN_POSITION;
    st.pos = {
      ...p,
      entryPrice: p.triggerPrice,
      actualEntryPrice,
      triggerPrice: p.triggerPrice,
      ...tpSl,
      openedAt: ts,
      entryOrderId,
      entryPriceActual,
      entryQtyActual,
      entryFillTs,
      tpPrice: tpSl.tpPrice,
      slPrice: tpSl.slPrice,
      tpOrderId,
      slOrderId,
      tpSlStatus,
    };
    st.pending = null;

    if (cfg.mode !== 'paper' && tradeExecutor?.enabled?.()) {
      await syncTpSlAttachment({ symbol, side: st.pos.side, pos: st.pos });
    } else {
      st.pos.tpSlStatus = TPSL_STATUS.ATTACHED;
    }

    sqlite.saveTrade({
      instanceId: id,
      mode: cfg.mode,
      symbol,
      side: st.pos.side,
      windowMinutes: cfg.windowMinutes,
      priceThresholdPct: cfg.priceThresholdPct,
      oiThresholdPct: cfg.oiThresholdPct,
      turnover24hMin: cfg.turnover24hMin,
      vol24hMin: cfg.vol24hMin,
      leverage: cfg.leverage,
      marginUsd: cfg.marginUsd,
      entryTs: p.createdAtMs,
      triggerPrice: p.triggerPrice,
      entryPrice: p.entryPrice,
      actualEntryPrice: st.pos.actualEntryPrice,
      exitTs: null,
      exitPrice: null,
      outcome: 'OPEN',
      pnlUsd: null,
      feesUsd: null,
      durationSec: null,
      entryOffsetPct: cfg.entryOffsetPct,
      turnoverSpikePct: cfg.turnoverSpikePct,
      baselineFloorUSDT: cfg.baselineFloorUSDT,
      holdSeconds: cfg.holdSeconds,
      trendConfirmSeconds: cfg.trendConfirmSeconds,
      oiMaxAgeSec: cfg.oiMaxAgeSec,
      lastPriceAtTrigger: p.lastPriceAtTrigger ?? null,
      markPriceAtTrigger: p.markPriceAtTrigger ?? null,
      entryOrderId: st.pos.entryOrderId,
      entryPriceActual: st.pos.entryPriceActual,
      entryQtyActual: st.pos.entryQtyActual,
      entryFillTs: st.pos.entryFillTs,
      tpPrice: st.pos.tpPrice,
      slPrice: st.pos.slPrice,
      tpSlStatus: st.pos.tpSlStatus,
      tpOrderId: st.pos.tpOrderId,
      slOrderId: st.pos.slOrderId,
    });
    log('trigger filled', { symbol, side: st.pos.side, triggerPrice: st.pos.triggerPrice, actualEntryPrice: st.pos.actualEntryPrice, tpSlStatus: st.pos.tpSlStatus });
  }

  function saveManualCancelTrade(symbol, pending, ts, outcome) {
    sqlite.saveTrade({ instanceId: id, mode: cfg.mode, symbol, side: pending.side, windowMinutes: cfg.windowMinutes, priceThresholdPct: cfg.priceThresholdPct, oiThresholdPct: cfg.oiThresholdPct, turnover24hMin: cfg.turnover24hMin, vol24hMin: cfg.vol24hMin, leverage: cfg.leverage, marginUsd: cfg.marginUsd, entryTs: pending.createdAtMs, triggerPrice: pending.triggerPrice, entryPrice: pending.triggerPrice, actualEntryPrice: null, exitTs: ts, exitPrice: pending.triggerPrice, outcome, pnlUsd: 0, feesUsd: 0, durationSec: Math.max(0, Math.round((ts - pending.createdAtMs) / 1000)), entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec, lastPriceAtTrigger: pending.lastPriceAtTrigger ?? null, markPriceAtTrigger: pending.markPriceAtTrigger ?? null });
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
    sqlite.saveSignal?.({ ...base, entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec });
  }

  async function onTick({ ts, sec }, eligibleSymbols) {
    if (status !== MOMENTUM_STATUS.RUNNING) return;
    const windowSec = cfg.windowMinutes * 60;
    let entries = 0;
    for (const symbol of eligibleSymbols) {
      const snap = marketData.getSnapshot(symbol);
      if (!snap || !(snap.markPrice > 0 && snap.lastPrice > 0 && snap.oiValue > 0)) {
        logSkipReason(symbol, null, 'NOT_READY_NO_PRICE_HISTORY', {}, 10_000);
        saveSignalBase({ instanceId: id, symbol, side: null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap?.markPrice || null, markPrev: null, lastNow: snap?.lastPrice || null, lastPrev: null, oiNow: snap?.oiValue || null, oiPrev: null, turnover24h: snap?.turnover24h || 0, vol24h: snap?.vol24h || 0, action: 'NOT_READY_NO_PRICE_HISTORY' });
        continue;
      }
      if (marketData.isDataFresh && !marketData.isDataFresh()) {
        logSkipReason(symbol, null, 'NOT_READY_WS_DISCONNECTED', {}, 10_000);
        saveSignalBase({ instanceId: id, symbol, side: null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap.markPrice, markPrev: null, lastNow: snap.lastPrice, lastPrev: null, oiNow: snap.oiValue, oiPrev: null, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NOT_READY_WS_DISCONNECTED' });
        continue;
      }
      const prev = marketData.getAtWindow(symbol, sec - windowSec);
      if (!prev || !(prev.lastPrice > 0)) {
        logSkipReason(symbol, null, 'NOT_READY_NO_PRICE_HISTORY', {}, 10_000);
        saveSignalBase({ instanceId: id, symbol, side: null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap.markPrice, markPrev: null, lastNow: snap.lastPrice, lastPrev: null, oiNow: snap.oiValue, oiPrev: null, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NOT_READY_NO_PRICE_HISTORY' });
        continue;
      }
      if (!(prev.oiValue > 0)) {
        logSkipReason(symbol, null, 'NOT_READY_NO_OI_HISTORY', {}, 10_000);
        saveSignalBase({ instanceId: id, symbol, side: null, ts, windowMinutes: cfg.windowMinutes, priceChange: null, oiChange: null, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NOT_READY_NO_OI_HISTORY' });
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
          sqlite.saveTrade({ instanceId: id, mode: cfg.mode, symbol, side: p.side, windowMinutes: cfg.windowMinutes, priceThresholdPct: cfg.priceThresholdPct, oiThresholdPct: cfg.oiThresholdPct, turnover24hMin: cfg.turnover24hMin, vol24hMin: cfg.vol24hMin, leverage: cfg.leverage, marginUsd: cfg.marginUsd, entryTs: p.createdAtMs, triggerPrice: p.triggerPrice, entryPrice: p.entryPrice, actualEntryPrice: p.actualEntryPrice, exitTs: ts, exitPrice, outcome: tpHit ? 'TP' : 'SL', pnlUsd: net, feesUsd: fees, durationSec: Math.round((ts - p.openedAt) / 1000), entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec, lastPriceAtTrigger: p.lastPriceAtTrigger ?? null, markPriceAtTrigger: p.markPriceAtTrigger ?? null, entryOrderId: p.entryOrderId ?? null, entryPriceActual: p.entryPriceActual ?? null, entryQtyActual: p.entryQtyActual ?? null, entryFillTs: p.entryFillTs ?? null, tpPrice: p.tpPrice ?? null, slPrice: p.slPrice ?? null, tpSlStatus: p.tpSlStatus ?? null, tpOrderId: p.tpOrderId ?? null, slOrderId: p.slOrderId ?? null });
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
          if (!(turnover.prev > 0)) {
            logSkipReason(symbol, side, 'NO_PREV_CANDLE', {}, 10_000);
            saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NO_PREV_CANDLE' });
            st.holdCount[side] = 0;
            continue;
          }
          if (!(turnover.median > 0)) {
            logSkipReason(symbol, side, 'NOT_READY_NO_TURNOVER_MEDIAN', {}, 10_000);
            saveSignalBase({ instanceId: id, symbol, side, ts, windowMinutes: cfg.windowMinutes, priceChange, oiChange, markNow: snap.markPrice, markPrev: prev.markPrice, lastNow: snap.lastPrice, lastPrev: prev.lastPrice, oiNow: snap.oiValue, oiPrev: prev.oiValue, turnover24h: snap.turnover24h || 0, vol24h: snap.vol24h || 0, action: 'NOT_READY_NO_TURNOVER_MEDIAN', prevTurnoverUSDT: turnover.prev, curTurnoverUSDT: turnover.cur, medianTurnoverUSDT: turnover.median, turnoverBaselineUSDT: turnover.baseline, turnoverGatePassed: 0 });
            st.holdCount[side] = 0;
            continue;
          }
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
    return { id, config: cfg, status, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), stats, openPositions, pendingOrders, cooldownCount, logs: logs.slice(0, 50), signalView, marginModeDesired: 'ISOLATED', isolatedPreflightOk: Boolean(isolatedPreflight?.ok), isolatedPreflightError: isolatedPreflight?.error || null };
  }

  return {
    id,
    onTick,
    stop: () => { status = MOMENTUM_STATUS.STOPPED; },
    cancelEntry,
    getSnapshot,
    getLight: () => ({ id, status, mode: cfg.mode, direction: cfg.directionMode, windowMinutes: cfg.windowMinutes, entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), trades: stats.trades, pnl: stats.pnl, fees: stats.fees, openPositionsCount: getSnapshot().openPositions.length, signals1m: stats.signals1m, signals5m: stats.signals5m, marginModeDesired: 'ISOLATED', isolatedPreflightOk: Boolean(isolatedPreflight?.ok), isolatedPreflightError: isolatedPreflight?.error || null }),
  };
}

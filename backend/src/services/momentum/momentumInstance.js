import { MOMENTUM_STATUS, SIDE, SYMBOL_STATE } from './momentumTypes.js';
import { BYBIT_STANDARD_FEES, calcChange, calcPaperPnlWithFees, calcTpSl, normalizeMomentumConfig, roundByTickForSide } from './momentumUtils.js';

const TPSL_STATUS = {
  PENDING: 'PENDING',
  ATTACHED: 'ATTACHED',
  UNKNOWN: 'UNKNOWN',
  FAILED: 'FAILED',
};

export function createMomentumInstance({ id, config, marketData, sqlite, tradeExecutor = null, logger = console, isolatedPreflight = null }) {
  const cfg = normalizeMomentumConfig(config);
  const symbols = new Map();
  const logs = [];
  const skipLogAt = new Map();
  const isolatedReadyBySymbol = new Map();
  const stats = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, signals1m: 0, signals5m: 0 };
  const signalViewBySymbol = new Map();
  const signalNotifications = [];
  const signalNoteAt = new Map();
  let status = MOMENTUM_STATUS.RUNNING;
  const startedAt = Date.now();
  let lastNoEvalNoteAt = 0;
  let lastActiveSyncAt = 0;
  let activeSyncCursor = 0;
  let lastBybitError = null;
  let lastBybitErrorLogAt = 0;
  let lastWarmupSummaryAt = 0;
  let lastHistoryBootstrapNoteAt = 0;
  const historyRetryAtBySymbol = new Map();
  const staleSinceBySymbol = new Map();
  let activePositionsCache = { ts: 0, count: 0 };
  let lastCapacityFullNoteAt = 0;

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

  function parseBybitError(err, fallbackOp = "UNKNOWN") {
    const text = String(err?.message || err || 'unknown');
    const retCodeMatch = text.match(/retCode=([^\s]+)/i);
    const retMsgMatch = text.match(/retMsg=(.*?)(?:\s+path=|$)/i);
    return {
      ts: Date.now(),
      op: fallbackOp,
      retCode: retCodeMatch ? String(retCodeMatch[1]) : null,
      retMsg: retMsgMatch ? String(retMsgMatch[1]).trim() : text,
    };
  }

  function setLastBybitError(err, op) {
    const next = parseBybitError(err, op);
    const prev = lastBybitError;
    const changed = !prev || prev.op !== next.op || prev.retCode !== next.retCode || prev.retMsg !== next.retMsg;
    const now = Date.now();
    if (changed || (now - lastBybitErrorLogAt) >= 30_000) {
      lastBybitError = next;
      lastBybitErrorLogAt = now;
      log('BYBIT_SYNC_WARNING', { op: next.op, retCode: next.retCode, retMsg: next.retMsg });
    }
  }

  function clearLastBybitError() {
    lastBybitError = null;
  }

  function parseFailureReason(err) {
    const msg = String(err?.message || err || 'unknown');
    if (msg.includes('MAX_ACTIVE_POSITIONS_GLOBAL')) return { reason: 'MAX_ACTIVE_POSITIONS_GLOBAL', detail: msg };
    if (msg.includes('ISOLATED_MARGIN_REQUIRED')) return { reason: 'ISOLATED_REQUIRED', detail: msg };
    return { reason: 'EXECUTION_FAILED', detail: msg };
  }

  function markFailed(st, ts, reason, detail, symbol) {
    st.state = SYMBOL_STATE.FAILED;
    st.fail = { at: ts, reason, detail: detail || 'unknown' };
    st.pending = null;
    if (st.pos) st.pos = null;
    if (symbol) pushSignalNote({ ts, symbol, action: 'ENTRY_FAILED', message: `${reason}${detail ? `: ${detail}` : ''}` }, 0);
  }

  function isTpAttached(orders, closeSide, position) {
    const reduceRows = (Array.isArray(orders) ? orders : []).filter((x) => x?.reduceOnly && String(x?.side || '').toLowerCase() === closeSide.toLowerCase() && String(x?.status || '').toLowerCase() !== 'filled');
    return reduceRows.length > 0 || (Number(position?.takeProfit || 0) > 0);
  }

  function isSlAttached(position) {
    return Number(position?.stopLoss || 0) > 0;
  }

  function updateTpSlStatusFromBybit(st, position, orders, nowTs) {
    if (!st?.pos) return;
    const closeSide = st.pos.side === SIDE.LONG ? 'Sell' : 'Buy';
    const hasSl = isSlAttached(position);
    const hasTp = isTpAttached(orders, closeSide, position);
    if (hasSl && hasTp) {
      st.pos.tpSlStatus = TPSL_STATUS.ATTACHED;
      st.pos.tpSlFailReason = null;
      return;
    }
    const sinceOpened = nowTs - Number(st.pos.openedAt || st.pos.createdAtMs || nowTs);
    if (sinceOpened < 5000) {
      st.pos.tpSlStatus = TPSL_STATUS.PENDING;
      return;
    }
    st.pos.tpSlStatus = TPSL_STATUS.FAILED;
    if (!hasSl && !hasTp) st.pos.tpSlFailReason = 'no stopLoss on position and no reduceOnly TP orders';
    else if (!hasSl) st.pos.tpSlFailReason = 'no stopLoss on position';
    else st.pos.tpSlFailReason = 'no reduceOnly TP orders';
  }

  async function getCapacityState(ts) {
    if (cfg.mode === 'paper' || !tradeExecutor?.enabled?.()) return { capacityFull: false, activePositionsCount: 0 };
    if ((ts - Number(activePositionsCache.ts || 0)) <= 2000) return { capacityFull: activePositionsCache.count >= 10, activePositionsCount: activePositionsCache.count };
    try {
      const rows = await tradeExecutor.getPositions?.({});
      const count = Array.isArray(rows) ? rows.filter((r) => Number(r?.size || 0) > 0).length : 0;
      activePositionsCache = { ts, count };
      return { capacityFull: count >= 10, activePositionsCount: count };
    } catch (err) {
      setLastBybitError(err, 'CAPACITY_CHECK');
      return { capacityFull: false, activePositionsCount: Number(activePositionsCache.count || 0) };
    }
  }

  function stateFor(symbol) {
    if (!symbols.has(symbol)) {
      symbols.set(symbol, {
        state: SYMBOL_STATE.IDLE,
        cooldownUntil: 0,
        pending: null,
        pos: null,
        fail: null,
        holdCount: { LONG: 0, SHORT: 0 },
        lastLastPrice: null,
        lastBusyUiUpdateAt: 0,
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
    st.pending = { side, triggerPrice, createdAtMs: nowMs, holdProgress: cfg.holdSeconds, trendProgress: cfg.trendConfirmSeconds, entryOffsetPct: cfg.entryOffsetPct, entryPriceSource: entrySource, lastPriceAtTrigger: snap.lastPrice, markPriceAtTrigger: snap.markPrice, currentPrice: snap.lastPrice };
    st.fail = null;
    st.holdCount.LONG = 0;
    st.holdCount.SHORT = 0;
    log('trigger created', { symbol, side, triggerPrice, markPrice: snap.markPrice, lastPrice: snap.lastPrice, entryPriceSource: entrySource });
    pushSignalNote({ ts: nowMs, symbol, side, lastPrice: snap.lastPrice, markPrice: snap.markPrice, action: 'TRIGGER_CREATED', message: `Trigger ${triggerPrice} from ${entrySource}` });
    return true;
  }

  function crossed(lastPrev, lastNow, triggerPrice) {
    if (!(Number.isFinite(lastPrev) && Number.isFinite(lastNow) && Number.isFinite(triggerPrice))) return false;
    if (lastNow === triggerPrice) return true;
    return (lastPrev < triggerPrice && lastNow >= triggerPrice) || (lastPrev > triggerPrice && lastNow <= triggerPrice);
  }

  function getEntrySourcePrice(snap, entryPriceSource) {
    const source = String(entryPriceSource || 'LAST').toUpperCase();
    const markPrice = Number(snap?.markPrice);
    const lastPrice = Number(snap?.lastPrice);
    if (source === 'MARK') return Number.isFinite(markPrice) ? markPrice : lastPrice;
    return lastPrice;
  }

  function isTriggerSatisfied(side, currentEntryPrice, triggerPrice) {
    if (!(Number.isFinite(currentEntryPrice) && Number.isFinite(triggerPrice))) return false;
    if (side === SIDE.LONG) return currentEntryPrice >= triggerPrice;
    if (side === SIDE.SHORT) return currentEntryPrice <= triggerPrice;
    return false;
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
    pos.tpSlStatus = TPSL_STATUS.FAILED;
    pos.tpSlFailReason = 'no reduceOnly TP orders';
    log('TPSL_SYNC_TIMEOUT', { symbol, side });
  }

  async function openPosition(symbol, st, snap, ts) {
    const p = st.pending;
    if (!p) return;
    const isolated = await ensureIsolatedOnFirstTrade(symbol);
    if (!isolated?.ok) {
      const detail = isolated?.error || 'unknown';
      log('entry blocked: isolated required', { symbol, error: detail });
      markFailed(st, ts, 'ISOLATED_REQUIRED', detail, symbol);
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
      const entryPriceUsed = getEntrySourcePrice(snap, p.entryPriceSource || cfg.entryPriceSource);
      try {
        const res = await tradeExecutor.openPosition({ symbol, side, qty, slPrice: tpSl.slPrice, tps: [{ price: tpSl.tpPrice }], leverage: cfg.leverage, priceHint: entryPriceUsed });
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
        const parsed = parseFailureReason(err);
        log('entry execution failed', { symbol, side: p.side, error: parsed.detail, reason: parsed.reason });
        markFailed(st, ts, parsed.reason, parsed.detail, symbol);
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
      tpRoiPct: cfg.tpRoiPct,
      slRoiPct: cfg.slRoiPct,
      tpOrderId,
      slOrderId,
      tpSlStatus,
    };
    st.pending = null;
    st.fail = null;

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
    pushSignalNote({ ts, symbol, side: st.pos.side, lastPrice: snap.lastPrice, markPrice: snap.markPrice, action: 'TRIGGER_FILLED', message: `Trigger ${st.pos.triggerPrice} filled at ${st.pos.actualEntryPrice || st.pos.entryPrice}` });
  }



  function getExitOutcome(side, currentPrice, tpPrice, slPrice) {
    if (!(Number(currentPrice) > 0)) return 'EXIT';
    if (side === SIDE.LONG) {
      if (Number(tpPrice) > 0 && currentPrice >= tpPrice) return 'TP_HIT';
      if (Number(slPrice) > 0 && currentPrice <= slPrice) return 'SL_HIT';
    } else {
      if (Number(tpPrice) > 0 && currentPrice <= tpPrice) return 'TP_HIT';
      if (Number(slPrice) > 0 && currentPrice >= slPrice) return 'SL_HIT';
    }
    return 'EXIT';
  }

  function isExitCrossed(side, currentPrice, tpPrice, slPrice) {
    if (!(Number(currentPrice) > 0)) return false;
    if (side === SIDE.LONG) return (Number(tpPrice) > 0 && currentPrice >= tpPrice) || (Number(slPrice) > 0 && currentPrice <= slPrice);
    return (Number(tpPrice) > 0 && currentPrice <= tpPrice) || (Number(slPrice) > 0 && currentPrice >= slPrice);
  }

  function finalizePositionClose(symbol, st, ts, currentPrice, outcomeOverride = null) {
    if (!st?.pos) return;
    const pos = st.pos;
    const entryPx = Number(pos.actualEntryPrice || pos.entryPrice || pos.triggerPrice || 0);
    const exitPx = Number(currentPrice || pos.currentPrice || entryPx || 0);
    const qty = Number(pos.entryQtyActual || ((cfg.marginUsd * cfg.leverage) / Math.max(1e-9, entryPx || 1)));
    const fees = calcPaperPnlWithFees({ side: pos.side, qty, entryPrice: entryPx, exitPrice: exitPx });
    const pnl = Number(fees.pnlNet || 0);
    const outcome = outcomeOverride || getExitOutcome(pos.side, exitPx, pos.tpPrice, pos.slPrice);
    sqlite.saveTrade({
      instanceId: id,
      mode: cfg.mode,
      symbol,
      side: pos.side,
      windowMinutes: cfg.windowMinutes,
      priceThresholdPct: cfg.priceThresholdPct,
      oiThresholdPct: cfg.oiThresholdPct,
      turnover24hMin: cfg.turnover24hMin,
      vol24hMin: cfg.vol24hMin,
      leverage: cfg.leverage,
      marginUsd: cfg.marginUsd,
      entryTs: pos.createdAtMs,
      triggerPrice: pos.triggerPrice,
      entryPrice: pos.entryPrice,
      actualEntryPrice: pos.actualEntryPrice || null,
      exitTs: ts,
      exitPrice: exitPx,
      outcome,
      pnlUsd: Number.isFinite(pnl) ? pnl : 0,
      feesUsd: Number(fees.feeEntry || 0) + Number(fees.feeExit || 0),
      qty,
      pnlGross: fees.pnlGross,
      pnlNet: fees.pnlNet,
      feeEntry: fees.feeEntry,
      feeExit: fees.feeExit,
      makerFeeRate: BYBIT_STANDARD_FEES.makerFeeRate,
      takerFeeRate: BYBIT_STANDARD_FEES.takerFeeRate,
      durationSec: Math.max(0, Math.round((ts - Number(pos.openedAt || pos.createdAtMs || ts)) / 1000)),
      entryOffsetPct: cfg.entryOffsetPct,
      turnoverSpikePct: cfg.turnoverSpikePct,
      baselineFloorUSDT: cfg.baselineFloorUSDT,
      holdSeconds: cfg.holdSeconds,
      trendConfirmSeconds: cfg.trendConfirmSeconds,
      oiMaxAgeSec: cfg.oiMaxAgeSec,
      tpPrice: pos.tpPrice,
      slPrice: pos.slPrice,
      lastPriceAtTrigger: pos.lastPriceAtTrigger ?? null,
      markPriceAtTrigger: pos.markPriceAtTrigger ?? null,
    });
    stats.trades += 1;
    stats.pnl += Number.isFinite(pnl) ? pnl : 0;
    if ((Number.isFinite(pnl) ? pnl : 0) >= 0) stats.wins += 1;
    else stats.losses += 1;
    st.pos = null;
    st.state = SYMBOL_STATE.IDLE;
    log('position closed', { symbol, outcome, exitPrice: exitPx });
    pushSignalNote({ ts, symbol, action: outcome, message: `Closed at ${exitPx}` }, 0);
  }

  function saveManualCancelTrade(symbol, pending, ts, outcome) {
    sqlite.saveTrade({ instanceId: id, mode: cfg.mode, symbol, side: pending.side, windowMinutes: cfg.windowMinutes, priceThresholdPct: cfg.priceThresholdPct, oiThresholdPct: cfg.oiThresholdPct, turnover24hMin: cfg.turnover24hMin, vol24hMin: cfg.vol24hMin, leverage: cfg.leverage, marginUsd: cfg.marginUsd, entryTs: pending.createdAtMs, triggerPrice: pending.triggerPrice, entryPrice: pending.triggerPrice, actualEntryPrice: null, exitTs: ts, exitPrice: pending.triggerPrice, outcome, pnlUsd: 0, feesUsd: 0, durationSec: Math.max(0, Math.round((ts - pending.createdAtMs) / 1000)), entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec, lastPriceAtTrigger: pending.lastPriceAtTrigger ?? null, markPriceAtTrigger: pending.markPriceAtTrigger ?? null });
  }



  function saveFixedSignal({ ts, symbol, side, action, reason = null, metrics = {} } = {}) {
    try {
      sqlite.saveFixedSignal?.({
        tsMs: ts,
        instanceId: id,
        symbol,
        side,
        windowMinutes: cfg.windowMinutes,
        action,
        reason,
        metrics,
      });
    } catch (err) {
      log('SAVE_FIXED_SIGNAL_FAILED', { symbol, side, action, error: String(err?.message || err) });
    }
  }

  function cancelEntry(symbol, { ts = Date.now(), outcome = 'MANUAL_CANCEL', logMessage = 'entry cancelled' } = {}) {
    const st = stateFor(symbol);
    if (st.state === SYMBOL_STATE.FAILED) {
      const fail = st.fail;
      st.fail = null;
      st.pending = null;
      st.state = SYMBOL_STATE.IDLE;
      log('failed entry cleared', { symbol, reason: fail?.reason || 'unknown' });
      return { ok: true, clearedFailed: true };
    }
    if (st.state !== SYMBOL_STATE.TRIGGER_PENDING || !st.pending) return { ok: false, reason: 'NOT_PENDING' };
    const pending = st.pending;
    st.pending = null;
    st.state = SYMBOL_STATE.IDLE;
    log(logMessage, { symbol, side: pending.side, outcome });
    saveManualCancelTrade(symbol, pending, ts, outcome);
    return { ok: true };
  }

  function getLongTurnoverGate(base) {
    const requiredMultiplier = 1 + (Number(cfg.turnoverSpikePct || 0) / 100);
    const prev = Number(base?.prevTurnoverUSDT || 0);
    const median = Number(base?.medianPrevTurnoverUSDT || 0);
    const cur = Number(base?.curTurnoverUSDT || 0);
    const baseline = Math.max(prev, median);
    const passed = cur >= baseline * requiredMultiplier;
    return { prev, median, cur, baseline, requiredMultiplier, passed };
  }

  function saveSignalBase(base) {
    sqlite.saveSignal?.({ ...base, entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, baselineFloorUSDT: cfg.baselineFloorUSDT, holdSeconds: cfg.holdSeconds, trendConfirmSeconds: cfg.trendConfirmSeconds, oiMaxAgeSec: cfg.oiMaxAgeSec });
  }

  function pushSignalNote(note = {}, throttleMs = 0) {
    const key = note?.throttleKey;
    const now = Date.now();
    if (key && throttleMs > 0) {
      const prev = Number(signalNoteAt.get(key) || 0);
      if ((now - prev) < throttleMs) return;
      signalNoteAt.set(key, now);
    }
    const clean = {
      ts: Number(note.ts || now),
      symbol: note.symbol || null,
      side: note.side || null,
      windowMinutes: cfg.windowMinutes,
      lastPrice: Number(note.lastPrice || 0) || null,
      markPrice: Number(note.markPrice || 0) || null,
      priceChangePct: Number.isFinite(Number(note.priceChange)) ? Number(note.priceChange) * 100 : null,
      oiChangePct: Number.isFinite(Number(note.oiChange)) ? Number(note.oiChange) * 100 : null,
      oiAgeSec: Number.isFinite(Number(note.oiAgeSec)) ? Number(note.oiAgeSec) : null,
      prevClose: Number.isFinite(Number(note.prevClose)) ? Number(note.prevClose) : null,
      priceNow: Number.isFinite(Number(note.priceNow)) ? Number(note.priceNow) : null,
      prevOiValue: Number.isFinite(Number(note.prevOiValue)) ? Number(note.prevOiValue) : null,
      oiNow: Number.isFinite(Number(note.oiNow)) ? Number(note.oiNow) : null,
      turnoverPrevUSDT: Number.isFinite(Number(note.turnoverPrevUSDT)) ? Number(note.turnoverPrevUSDT) : null,
      turnoverCurUSDT: Number.isFinite(Number(note.turnoverCurUSDT)) ? Number(note.turnoverCurUSDT) : null,
      turnoverMedianUSDT: Number.isFinite(Number(note.turnoverMedianUSDT)) ? Number(note.turnoverMedianUSDT) : null,
      turnoverBaselineUSDT: Number.isFinite(Number(note.turnoverBaselineUSDT)) ? Number(note.turnoverBaselineUSDT) : null,
      turnoverSpikePct: Number.isFinite(Number(note.turnoverSpikePct)) ? Number(note.turnoverSpikePct) : null,
      turnoverGatePassed: typeof note.turnoverGatePassed === 'boolean' ? note.turnoverGatePassed : null,
      holdProgress: Number.isFinite(Number(note.holdProgress)) ? Number(note.holdProgress) : null,
      holdTarget: Number.isFinite(Number(note.holdTarget)) ? Number(note.holdTarget) : null,
      trendConfirmSeconds: Number.isFinite(Number(note.trendConfirmSeconds)) ? Number(note.trendConfirmSeconds) : null,
      historySecondsAvailable: Number.isFinite(Number(note.historySecondsAvailable)) ? Number(note.historySecondsAvailable) : null,
      candleStartMs: Number.isFinite(Number(note.candleStartMs)) ? Number(note.candleStartMs) : null,
      action: note.action || 'INFO',
      message: note.message || '',
      lastUpdateTs: now,
    };
    signalNotifications.unshift(clean);
    if (signalNotifications.length > 200) signalNotifications.length = 200;
  }

  async function onTick({ ts }, eligibleSymbols) {
    if (status !== MOMENTUM_STATUS.RUNNING) return;
    const evalSymbols = Array.isArray(eligibleSymbols) ? eligibleSymbols : [];
    if (evalSymbols.length === 0) {
      if ((ts - lastNoEvalNoteAt) >= 10000) {
        lastNoEvalNoteAt = ts;
        pushSignalNote({ ts, action: 'NOT_READY_NO_EVAL_SYMBOLS', message: 'No symbols in evaluation set' }, 0);
      }
      return;
    }
    let entries = 0;
    let universeSeedAttempts = 0;
    let missingLastPriceCount = 0;
    let missingHistoryCount = 0;
    let historyFetchFailedCount = 0;
    const staleCutoffTs = ts - 30_000;
    const capacity = await getCapacityState(ts);
    const capacityFull = capacity.capacityFull;
    if (capacityFull && (ts - lastCapacityFullNoteAt) >= 15_000) {
      lastCapacityFullNoteAt = ts;
      pushSignalNote({ ts, action: 'CAPACITY_FULL', message: `Max 10 open positions reached; new entries paused; UI updates every ${cfg.windowMinutes} minutes` }, 0);
    }
    for (const symbol of evalSymbols) {
      const snap = marketData.getSnapshot(symbol);
      if (!snap) {
        if (!marketData.isSymbolInDesiredSet?.(symbol) || !marketData.isSymbolSubscribed?.(symbol)) continue;
        logSkipReason(symbol, null, 'NOT_READY_NO_SNAPSHOT', {}, 10000);
        pushSignalNote({ ts, symbol, action: 'NOT_READY_NO_SNAPSHOT', message: 'No ticker snapshot yet', throttleKey: `${symbol}:NOT_READY_NO_SNAPSHOT` }, 10000);
        continue;
      }
      if (!(Number(snap.lastPrice) > 0)) {
        if (!marketData.isSymbolInDesiredSet?.(symbol) || !marketData.isSymbolSubscribed?.(symbol)) continue;
        missingLastPriceCount += 1;
        continue;
      }
      if (marketData.isDataFresh && !marketData.isDataFresh()) {
        logSkipReason(symbol, null, 'NOT_READY_WS_DISCONNECTED', {}, 10_000);
        pushSignalNote({ ts, symbol, action: 'NOT_READY_WS_DISCONNECTED', message: 'Market WS not fresh', throttleKey: `${symbol}:NOT_READY_WS_DISCONNECTED` }, 10000);
        continue;
      }

      const st = stateFor(symbol);
      const currentPrice = Number(snap.lastPrice);
      const lastTs = Number(snap.tsMs || snap.ts || ts);
      if (lastTs < staleCutoffTs) {
        const staleSince = Number(staleSinceBySymbol.get(symbol) || ts);
        staleSinceBySymbol.set(symbol, staleSince);
        pushSignalNote({ ts, symbol, action: 'STALE_TICKER', message: 'Ticker stale >30s, temporarily excluded', throttleKey: `${symbol}:STALE_TICKER` }, 10000);
        continue;
      }
      staleSinceBySymbol.delete(symbol);
      const busyUpdateIntervalMs = capacityFull ? (Number(cfg.windowMinutes || 1) * 60 * 1000) : 1000;
      const shouldUpdateBusyUiPrice = !st.lastBusyUiUpdateAt || (ts - st.lastBusyUiUpdateAt) >= busyUpdateIntervalMs;
      if (shouldUpdateBusyUiPrice) st.lastBusyUiUpdateAt = ts;
      if (st.pending && shouldUpdateBusyUiPrice) st.pending.currentPrice = Number.isFinite(currentPrice) ? currentPrice : st.pending.currentPrice;
      if (st.pos && shouldUpdateBusyUiPrice) st.pos.currentPrice = Number.isFinite(currentPrice) ? currentPrice : st.pos.currentPrice;

      if (st.state === SYMBOL_STATE.TRIGGER_PENDING && st.pending) {
        const entryPriceSource = st.pending.entryPriceSource || cfg.entryPriceSource;
        const entryPx = getEntrySourcePrice(snap, entryPriceSource);
        if (isTriggerSatisfied(st.pending.side, entryPx, st.pending.triggerPrice)) {
          if (capacityFull) {
            markFailed(st, ts, 'MAX_ACTIVE_POSITIONS_GLOBAL', `active=${capacity.activePositionsCount}; max=10`, symbol);
          } else {
            const resolvedSide = st.pending?.side || st.pos?.side || st.side || 'UNKNOWN';
            log('trigger satisfied', { symbol, side: st.pending.side, triggerPrice: st.pending.triggerPrice, entryPx, entryPriceSource });
            saveFixedSignal({ ts, symbol, side: resolvedSide, action: 'ENTRY_ATTEMPT', metrics: { entryPriceSource, entryPx, triggerPrice: st.pending?.triggerPrice, priceChangePctW: Number(priceChange || 0) * 100, oiChangePctW: Number(oiChange || 0) * 100 } });
            await openPosition(symbol, st, snap, ts);
          }
        }
        st.lastLastPrice = currentPrice;
        continue;
      }

      if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) {
        const crossedExit = isExitCrossed(st.pos.side, currentPrice, st.pos.tpPrice, st.pos.slPrice);
        if (cfg.mode === 'paper' && crossedExit) {
          finalizePositionClose(symbol, st, ts, currentPrice);
          st.lastLastPrice = currentPrice;
          continue;
        }
        if (cfg.mode !== 'paper' && crossedExit && tradeExecutor?.enabled?.()) {
          const now = Date.now();
          if (!st.pos.exitTriggeredLocalAt) st.pos.exitTriggeredLocalAt = now;
          if (!st.pos.lastExitAttemptAt || (now - st.pos.lastExitAttemptAt) >= 5000) {
            st.pos.lastExitAttemptAt = now;
            try {
              await tradeExecutor.closePositionMarket({ symbol });
              pushSignalNote({ ts, symbol, action: 'EXIT_TRIGGERED_LOCAL', message: 'Local TP/SL watcher requested close' }, 0);
            } catch (err) {
              log('EXIT_CLOSE_REQUEST_FAILED', { symbol, error: String(err?.message || err) });
            }
          }
        }
        st.lastLastPrice = currentPrice;
        continue;
      }

      let baseline = marketData.getCandleBaseline?.(symbol, cfg.windowMinutes) || { ok: false, reason: 'NO_PREV_CANDLE' };
      if (!baseline.ok && marketData.seedKlineBaseline) {
        if (cfg.scanMode === 'SINGLE') {
          await marketData.seedKlineBaseline(symbol, cfg.windowMinutes, true);
          baseline = marketData.getCandleBaseline?.(symbol, cfg.windowMinutes) || baseline;
        } else if (universeSeedAttempts < 3) {
          universeSeedAttempts += 1;
          marketData.seedKlineBaseline(symbol, cfg.windowMinutes, true).catch(() => {});
        }
      }
      if (!baseline.ok) {
        const reason = baseline.reason === 'NO_PREV_CANDLE' ? 'NOT_READY_NO_PREV_CANDLE' : 'NOT_READY_BASELINE_MISSING';
        logSkipReason(symbol, null, reason, {}, 4000);
        pushSignalNote({ ts, symbol, action: reason, message: baseline.reason || 'No baseline yet', throttleKey: `${symbol}:${reason}` }, 10000);
        continue;
      }

      if (!(Number(snap.oiValue) > 0)) {
        logSkipReason(symbol, null, 'NOT_READY_NO_OI', {}, 4000);
        pushSignalNote({ ts, symbol, action: 'NOT_READY_NO_OI', message: 'Snapshot present but oiValue missing', throttleKey: `${symbol}:NOT_READY_NO_OI` }, 10000);
        continue;
      }
      if (!(Number(baseline.prevOiValue) > 0)) {
        logSkipReason(symbol, null, 'NOT_READY_NO_PREV_OI', {}, 4000);
        pushSignalNote({ ts, symbol, action: 'NOT_READY_NO_PREV_OI', message: 'No previous OI baseline', throttleKey: `${symbol}:NOT_READY_NO_PREV_OI` }, 10000);
        continue;
      }

      const requiredHistorySec = Math.max(0, Number(cfg.trendConfirmSeconds) + 1);
      const historySecondsAvailable = Number(marketData.getHistorySecondsAvailable?.(symbol) || 0);
      if (cfg.trendConfirmSeconds > 0 && historySecondsAvailable < requiredHistorySec) {
        missingHistoryCount += 1;
        const retryAt = Number(historyRetryAtBySymbol.get(symbol) || 0);
        if (ts >= retryAt && marketData.bootstrapPriceHistory) {
          historyRetryAtBySymbol.set(symbol, ts + 30_000);
          const seeded = await marketData.bootstrapPriceHistory(symbol, cfg.windowMinutes, requiredHistorySec);
          if (!seeded?.ok) {
            historyFetchFailedCount += 1;
            pushSignalNote({ ts, symbol, action: 'HISTORY_FETCH_FAILED', message: seeded?.error || seeded?.reason || 'history bootstrap failed', throttleKey: `${symbol}:HISTORY_FETCH_FAILED` }, 10_000);
          } else {
            historyRetryAtBySymbol.delete(symbol);
          }
        }
        continue;
      }
      historyRetryAtBySymbol.delete(symbol);

      const priceChange = calcChange(snap.lastPrice, baseline.prevClose);
      const oiChange = calcChange(snap.oiValue, baseline.prevOiValue);
      const oiAgeSec = Number(marketData.getOiAgeSec?.(symbol));
      const oiFresh = oiAgeSec <= cfg.oiMaxAgeSec;
      signalViewBySymbol.set(symbol, { symbol, ts, markPrice: snap.markPrice, lastPrice: snap.lastPrice, priceChange, oiValueNow: snap.oiValue, oiChange });

      if (entries >= cfg.maxNewEntriesPerTick) continue;
      if (capacityFull) continue;

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
          pushSignalNote({ ts, symbol, side, action: 'NOT_READY_OI_STALE', message: `OI stale ${Number(oiAgeSec).toFixed(1)}s`, oiAgeSec, throttleKey: `${symbol}:${side}:NOT_READY_OI_STALE` }, 2000);
          continue;
        }

        let turnoverOk = true;
        let turnover = null;
        if (side === SIDE.LONG && Number(cfg.turnoverSpikePct) > 0) {
          turnover = getLongTurnoverGate(baseline);
          if (!(turnover.baseline >= Number(cfg.baselineFloorUSDT || 0))) {
            st.holdCount[side] = 0;
            pushSignalNote({ ts, symbol, side, action: 'NOT_READY_BASELINE_TOO_SMALL', message: 'Turnover baseline below floor', turnoverPrevUSDT: turnover.prev, turnoverMedianUSDT: turnover.median, turnoverCurUSDT: turnover.cur, turnoverBaselineUSDT: turnover.baseline, turnoverGatePassed: false, throttleKey: `${symbol}:${side}:NOT_READY_BASELINE_TOO_SMALL` }, 2000);
            continue;
          }
          turnoverOk = turnover.passed;
          if (!turnoverOk) {
            st.holdCount[side] = 0;
            pushSignalNote({ ts, symbol, side, action: 'SKIP_TURNOVER_GATE_FAIL', message: 'Turnover gate failed', turnoverPrevUSDT: turnover.prev, turnoverMedianUSDT: turnover.median, turnoverCurUSDT: turnover.cur, turnoverBaselineUSDT: turnover.baseline, turnoverGatePassed: false, throttleKey: `${symbol}:${side}:SKIP_TURNOVER_GATE_FAIL` }, 2000);
            continue;
          }
        }

        const allOk = priceOk && oiOk && trendOk && turnoverOk;
        st.holdCount[side] = allOk ? (st.holdCount[side] + 1) : 0;
        pushSignalNote({
          ts,
          symbol,
          side,
          action: allOk ? 'TRIGGER_CHECK' : 'SKIP_CONDITION',
          message: allOk ? `Holding ${st.holdCount[side]}/${cfg.holdSeconds}` : 'Conditions not met',
          lastPrice: snap.lastPrice,
          markPrice: snap.markPrice,
          prevClose: baseline.prevClose,
          priceNow: snap.lastPrice,
          priceChange,
          prevOiValue: baseline.prevOiValue,
          oiNow: snap.oiValue,
          oiChange,
          oiAgeSec,
          holdProgress: st.holdCount[side],
          holdTarget: cfg.holdSeconds,
          trendConfirmSeconds: cfg.trendConfirmSeconds,
          historySecondsAvailable,
          turnoverPrevUSDT: baseline.prevTurnoverUSDT,
          turnoverMedianUSDT: baseline.medianPrevTurnoverUSDT,
          turnoverCurUSDT: baseline.curTurnoverUSDT,
          turnoverSpikePct: cfg.turnoverSpikePct,
          turnoverGatePassed: turnoverOk,
          candleStartMs: baseline.curCandleStartMs,
          throttleKey: `${symbol}:${side}:PROGRESS`,
        }, 1500);
        if (allOk && st.holdCount[side] < cfg.holdSeconds) continue;
        if (allOk && st.holdCount[side] >= cfg.holdSeconds && createTrigger(symbol, side, snap, ts, st)) {
          saveFixedSignal({ ts, symbol, side, action: 'TRIGGER_CREATED', metrics: { priceChangePctW: Number(priceChange || 0) * 100, oiChangePctW: Number(oiChange || 0) * 100, turnover24h: snap.turnover24h, volatility24h: snap.vol24h, hold: st.holdCount[side], trendConfirm: cfg.trendConfirmSeconds } });
          entries += 1;
          const entryPriceSource = st.pending?.entryPriceSource || cfg.entryPriceSource;
          const entryPx = getEntrySourcePrice(snap, entryPriceSource);
          if (isTriggerSatisfied(side, entryPx, st.pending?.triggerPrice)) {
            log('trigger satisfied', { symbol, side, triggerPrice: st.pending?.triggerPrice, entryPx, entryPriceSource });
            saveFixedSignal({ ts, symbol, side, action: 'ENTRY_ATTEMPT', metrics: { entryPriceSource, entryPx, triggerPrice: st.pending?.triggerPrice, priceChangePctW: Number(priceChange || 0) * 100, oiChangePctW: Number(oiChange || 0) * 100 } });
            await openPosition(symbol, st, snap, ts);
          }
          break;
        }
      }

      st.lastLastPrice = Number(snap.lastPrice);
    }

    if (missingLastPriceCount > 0 && (ts - lastWarmupSummaryAt) >= 5000) {
      lastWarmupSummaryAt = ts;
      log('WARMUP_MISSING_LASTPRICE', { missing: missingLastPriceCount, total: evalSymbols.length });
      pushSignalNote({ ts, action: 'WARMUP_MISSING_LASTPRICE', message: `${missingLastPriceCount}/${evalSymbols.length}` }, 0);
    }

    if ((missingHistoryCount > 0 || historyFetchFailedCount > 0) && (ts - lastHistoryBootstrapNoteAt) >= 5000) {
      lastHistoryBootstrapNoteAt = ts;
      pushSignalNote({ ts, action: 'WARMUP_HISTORY_BOOTSTRAP', message: `missing history ${missingHistoryCount}/${evalSymbols.length}${historyFetchFailedCount > 0 ? `, fetch failed ${historyFetchFailedCount}` : ''}` }, 0);
    }

    if (cfg.mode !== 'paper' && tradeExecutor?.enabled?.() && (ts - lastActiveSyncAt) >= 7000) {
      lastActiveSyncAt = ts;
      const activeSymbols = [...symbols.entries()]
        .filter(([, st]) => (st.state === SYMBOL_STATE.TRIGGER_PENDING && st.pending) || st.state === SYMBOL_STATE.FAILED || (st.state === SYMBOL_STATE.IN_POSITION && st.pos))
        .map(([symbol]) => symbol);

      if (activeSymbols.length > 0) {
        const maxSymbolsPerTick = 10;
        const start = activeSyncCursor % activeSymbols.length;
        const rotated = activeSymbols.slice(start).concat(activeSymbols.slice(0, start));
        const scopedSymbols = rotated.slice(0, maxSymbolsPerTick);
        activeSyncCursor = (start + scopedSymbols.length) % activeSymbols.length;

        let sawSyncError = false;
        for (const symbol of scopedSymbols) {
          const st = stateFor(symbol);
          try {
            const pos = await tradeExecutor.getPosition?.({ symbol });
            const orders = await tradeExecutor.getOpenOrders?.({ symbol });
            const size = Number(pos?.size || 0);
            if ((st.state === SYMBOL_STATE.TRIGGER_PENDING || st.state === SYMBOL_STATE.FAILED) && size > 0) {
              const posSideRaw = String(pos?.side || '').toUpperCase();
              const side = posSideRaw === 'BUY' ? SIDE.LONG : SIDE.SHORT;
              st.state = SYMBOL_STATE.IN_POSITION;
              st.pos = {
                ...(st.pos || {}),
                ...(st.pending || {}),
                side,
                openedAt: Number(st.pos?.openedAt || st.pending?.createdAtMs || ts),
                entryPriceActual: Number(pos?.avgPrice || 0) > 0 ? Number(pos.avgPrice) : st.pos?.entryPriceActual || null,
                actualEntryPrice: Number(pos?.avgPrice || 0) > 0 ? Number(pos.avgPrice) : st.pos?.actualEntryPrice || null,
                entryQtyActual: Number(pos?.size || 0) > 0 ? Number(pos.size) : st.pos?.entryQtyActual || null,
                currentPrice: Number(marketData.getSnapshot(symbol)?.lastPrice || st.pos?.currentPrice || 0) || st.pos?.currentPrice,
                tpSlStatus: st.pos?.tpSlStatus || TPSL_STATUS.PENDING,
              };
              st.pending = null;
              st.fail = null;
            }
            if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) {
              updateTpSlStatusFromBybit(st, pos, orders, ts);
              if (!(size > 0) && st.pos.exitTriggeredLocalAt) {
                finalizePositionClose(symbol, st, ts, Number(st.pos.currentPrice || marketData.getSnapshot(symbol)?.lastPrice || 0), 'DEMO_SYNC_CLOSE');
              }
            }
          } catch (err) {
            sawSyncError = true;
            setLastBybitError(err, 'ACTIVE_SYNC');
          }
        }

        if (!sawSyncError) clearLastBybitError();
      }
    }
  }


  function getSnapshot() {
    const openPositions = [];
    const pendingOrders = [];
    let cooldownCount = 0;
    for (const [symbol, st] of symbols.entries()) {
      if (st.state === SYMBOL_STATE.IN_POSITION && st.pos) openPositions.push({ symbol, ...st.pos });
      if (st.state === SYMBOL_STATE.TRIGGER_PENDING && st.pending) {
        pendingOrders.push({ symbol, state: SYMBOL_STATE.TRIGGER_PENDING, ...st.pending, ageSec: Math.floor((Date.now() - st.pending.createdAtMs) / 1000) });
      }
      if (st.state === SYMBOL_STATE.FAILED && st.fail) {
        const createdAtMs = Number(st.fail.at || Date.now());
        pendingOrders.push({ symbol, state: SYMBOL_STATE.FAILED, createdAtMs, ageSec: Math.floor((Date.now() - createdAtMs) / 1000), failReason: st.fail.reason || 'unknown', failDetail: st.fail.detail || null, side: st.pending?.side || null, triggerPrice: st.pending?.triggerPrice || null, currentPrice: st.pending?.currentPrice || null });
      }
      if (st.state === SYMBOL_STATE.COOLDOWN) cooldownCount += 1;
    }
    const signalView = [...signalViewBySymbol.values()].sort((a, b) => b.ts - a.ts).slice(0, 30);
    return { id, config: cfg, status, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), stats, openPositions, pendingOrders, cooldownCount, logs: logs.slice(0, 50), signalView, signalNotifications: signalNotifications.slice(0, 50), marginModeDesired: 'ISOLATED', isolatedPreflightOk: Boolean(isolatedPreflight?.ok), isolatedPreflightError: isolatedPreflight?.error || null, lastBybitError };
  }

  return {
    id,
    onTick,
    stop: () => { status = MOMENTUM_STATUS.STOPPED; },
    start: () => { status = MOMENTUM_STATUS.RUNNING; },
    cancelEntry,
    getSnapshot,
    getLight: () => ({ id, status, mode: cfg.mode, scanMode: cfg.scanMode, universeMode: cfg.universeMode, universeTierIndex: cfg.universeTierIndex, universeSource: cfg.universeSource, singleSymbol: cfg.singleSymbol, tierIndices: Array.isArray(cfg.tierIndices) ? cfg.tierIndices : [], resolvedSymbolsCount: Number(cfg.resolvedSymbolsCount || (Array.isArray(cfg.evalSymbols) ? cfg.evalSymbols.length : 0)), direction: cfg.directionMode, windowMinutes: cfg.windowMinutes, entryOffsetPct: cfg.entryOffsetPct, turnoverSpikePct: cfg.turnoverSpikePct, startedAt, uptimeSec: Math.floor((Date.now() - startedAt) / 1000), trades: stats.trades, pnl: stats.pnl, fees: stats.fees, openPositionsCount: getSnapshot().openPositions.length, signals1m: stats.signals1m, signals5m: stats.signals5m, marginModeDesired: 'ISOLATED', isolatedPreflightOk: Boolean(isolatedPreflight?.ok), isolatedPreflightError: isolatedPreflight?.error || null, lastBybitError }),
  };
}

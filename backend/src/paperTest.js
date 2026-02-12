function safeNum(x, fallback = null) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
const MAX_POSITIONS = 5;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

function now() { return Date.now(); }
function runKeyFromSettings(settings) {
  const s = settings || {};
  return [s.leaderSymbol, s.followerSymbol, s.leaderMovePct, s.followerTpPct, s.followerSlPct, s.allowShort, s.lagMs].join('|');
}
function pickPx(t) {
  const mark = safeNum(t?.mark, null);
  if (Number.isFinite(mark) && mark > 0) return mark;
  const mid = safeNum(t?.mid, null);
  if (Number.isFinite(mid) && mid > 0) return mid;
  const last = safeNum(t?.last, safeNum(t?.lastPrice, null));
  return Number.isFinite(last) && last > 0 ? last : null;
}

export function createPaperTest({ getLeadLagTop, getMarketTicker = () => null, getUniverseSymbols = () => [], presetsStore, logger = console, onEvent = () => {}, tickMs = 250 } = {}) {
  const state = {
    status: 'STOPPED', startedAt: null, endedAt: null, ticks: 0,
    activePresetId: null, sessionPresetId: null, lastLeadLagTop: [], lastNoEntryReasons: [],
    settings: null, executionMode: 'paper',
    pendingSignal: null, positions: [],
    stats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0, feeRateMaker: 0.0002 },
    manual: { enabled: false, leaderSymbol: null, followerSymbol: null, leaderMovePct: 1, followerTpPct: 1, followerSlPct: 1, allowShort: true, lagMs: 250, leaderBaseline: null, leaderPrice: null, followerPrice: null, leaderMovePctNow: 0, lastNoEntryReason: null },
    currentRunKey: null, currentTradeEvents: [], runHistory: {},
  };
  let logs = [];
  let trades = [];

  function emit(type, payload) { try { onEvent({ type, payload }); } catch {} }
  function emitLeadLag(type, payload) { emit(type, payload); emit(type.replace('leadlag.', 'paper.'), payload); }
  function pushLog(level, msg, extra = {}) { const row = { ts: now(), level, msg, ...extra }; logs.unshift(row); logs = logs.slice(0, 300); emitLeadLag('leadlag.log', row); }
  function getTicker(symbol) { return getMarketTicker(symbol, 'BT'); }

  function upsertHistory(runKey) {
    if (!state.runHistory[runKey]) {
      state.runHistory[runKey] = { runKey, settings: { ...(state.settings || {}) }, pair: `${state.settings?.leaderSymbol || ''}/${state.settings?.followerSymbol || ''}`, confirmations: 0, trades: 0, wins: 0, losses: 0, pnlUSDT: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0 };
    }
    return state.runHistory[runKey];
  }

  function openPosition(side, decisionPx, execPx) {
    const s = state.settings || {};
    if (state.positions.length >= MAX_POSITIONS) {
      state.lastNoEntryReasons = [{ key: 'MAX_POSITIONS_REACHED', detail: `positions=${state.positions.length}/${MAX_POSITIONS}` }];
      return;
    }
    const qty = Math.max(0.0001, (safeNum(presetsStore?.getActivePreset?.()?.params?.maxNotionalUsd, 100) || 100) / execPx);
    const tp = side === 'LONG' ? execPx * (1 + s.followerTpPct / 100) : execPx * (1 - s.followerTpPct / 100);
    const sl = side === 'LONG' ? execPx * (1 - s.followerSlPct / 100) : execPx * (1 + s.followerSlPct / 100);
    const feeEntry = execPx * qty * state.stats.feeRateMaker;
    state.stats.feesUSDT += feeEntry;
    state.stats.pnlUSDT -= feeEntry;
    const pos = { id: `${now()}-${Math.random()}`, symbol: s.followerSymbol, side, entryPrice: execPx, theoreticalEntry: decisionPx, slPrice: sl, tpPrice: tp, openedAt: now(), qty, feeEntry, fundingAccrued: 0 };
    state.positions.push(pos);
    emitLeadLag('leadlag.trade', { ts: now(), event: 'OPEN', symbol: pos.symbol, side, entryPrice: pos.entryPrice, qty: pos.qty, runKey: state.currentRunKey });
    state.currentTradeEvents.unshift({ ts: now(), event: 'OPEN', symbol: pos.symbol, side, entryPrice: pos.entryPrice, qty: pos.qty });
    state.currentTradeEvents = state.currentTradeEvents.slice(0, 20);
  }

  function maybeClosePosition(pos, px, fundingRate) {
    const hitTp = pos.side === 'LONG' ? px >= pos.tpPrice : px <= pos.tpPrice;
    const hitSl = pos.side === 'LONG' ? px <= pos.slPrice : px >= pos.slPrice;
    if (!hitTp && !hitSl) return false;

    const actualExit = px;
    const theoreticalExit = hitTp ? pos.tpPrice : pos.slPrice;
    const pnlCore = (pos.side === 'LONG' ? (actualExit - pos.entryPrice) : (pos.entryPrice - actualExit)) * pos.qty;
    const feeExit = actualExit * pos.qty * state.stats.feeRateMaker;
    const fundingIntervals = Math.max(0, Math.floor((now() - pos.openedAt) / FUNDING_INTERVAL_MS));
    const fr = Number.isFinite(fundingRate) ? fundingRate : 0;
    const notional = actualExit * pos.qty;
    const sideSign = pos.side === 'LONG' ? 1 : -1;
    const funding = fundingIntervals * (-fr * notional * sideSign);
    const slippage = (pos.side === 'LONG' ? (actualExit - theoreticalExit) : (theoreticalExit - actualExit)) * pos.qty
      + (pos.side === 'LONG' ? (pos.entryPrice - pos.theoreticalEntry) : (pos.theoreticalEntry - pos.entryPrice)) * pos.qty;

    const pnl = pnlCore - feeExit + funding;
    state.stats.trades += 1;
    if (pnl >= 0) state.stats.wins += 1; else state.stats.losses += 1;
    state.stats.pnlUSDT += pnl;
    state.stats.feesUSDT += feeExit;
    state.stats.fundingUSDT += funding;
    state.stats.slippageUSDT += slippage;
    state.stats.winRate = state.stats.trades ? (state.stats.wins / state.stats.trades) * 100 : 0;

    const row = { ts: now(), event: 'CLOSE', symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice: actualExit, theoreticalExit, pnlUSDT: pnl, feesUSDT: feeExit + pos.feeEntry, fundingUSDT: funding, slippageUSDT: slippage, reason: hitTp ? 'TP' : 'SL', runKey: state.currentRunKey };
    trades.unshift(row); trades = trades.slice(0, 300);
    state.currentTradeEvents.unshift(row); state.currentTradeEvents = state.currentTradeEvents.slice(0, 20);
    emitLeadLag('leadlag.trade', row);

    const hist = upsertHistory(state.currentRunKey);
    hist.trades += 1; if (pnl >= 0) hist.wins += 1; else hist.losses += 1;
    hist.pnlUSDT += pnl; hist.feesUSDT += feeExit + pos.feeEntry; hist.fundingUSDT += funding; hist.slippageUSDT += slippage;
    return true;
  }

  function step() {
    if (state.status !== 'RUNNING') return;
    state.ticks += 1;
    state.lastLeadLagTop = Array.isArray(getLeadLagTop?.()) ? getLeadLagTop().slice(0, 10) : [];
    const s = state.settings || {};
    const leaderTicker = getTicker(s.leaderSymbol);
    const followerTicker = getTicker(s.followerSymbol);
    const leaderPx = pickPx(leaderTicker);
    const followerPx = pickPx(followerTicker);
    state.manual.leaderPrice = leaderPx;
    state.manual.followerPrice = followerPx;

    if (!Number.isFinite(state.manual.leaderBaseline) && Number.isFinite(leaderPx)) state.manual.leaderBaseline = leaderPx;
    if (Number.isFinite(leaderPx) && Number.isFinite(state.manual.leaderBaseline) && state.manual.leaderBaseline > 0) {
      state.manual.leaderMovePctNow = ((leaderPx - state.manual.leaderBaseline) / state.manual.leaderBaseline) * 100;
    }

    if (!state.pendingSignal && Number.isFinite(leaderPx) && Number.isFinite(followerPx) && Number.isFinite(state.manual.leaderBaseline) && state.manual.leaderBaseline > 0) {
      const movePct = ((leaderPx - state.manual.leaderBaseline) / state.manual.leaderBaseline) * 100;
      if (Math.abs(movePct) >= s.leaderMovePct) {
        const side = movePct >= 0 ? 'LONG' : 'SHORT';
        if (side === 'SHORT' && !s.allowShort) {
          state.lastNoEntryReasons = [{ key: 'SHORT_DISABLED', detail: 'allowShort=false' }];
        } else {
          state.pendingSignal = { side, executeAt: now() + s.lagMs, theoreticalEntry: followerPx };
        }
      }
    }

    if (state.pendingSignal && now() >= state.pendingSignal.executeAt) {
      if (Number.isFinite(followerPx) && followerPx > 0) openPosition(state.pendingSignal.side, state.pendingSignal.theoreticalEntry, followerPx);
      else state.lastNoEntryReasons = [{ key: 'NO_FOLLOWER_PRICE', detail: 'missing price at executeAt' }];
      state.pendingSignal = null;
      if (Number.isFinite(leaderPx) && leaderPx > 0) state.manual.leaderBaseline = leaderPx;
    }

    const fr = safeNum(followerTicker?.fundingRate, 0);
    const remaining = [];
    for (const p of state.positions) {
      if (!Number.isFinite(followerPx)) { remaining.push(p); continue; }
      const closed = maybeClosePosition(p, followerPx, fr);
      if (!closed) remaining.push(p);
    }
    state.positions = remaining;

    emitLeadLag('leadlag.state', getState({ includeHistory: false }));
  }

  const timer = setInterval(() => { try { step(); } catch (e) { logger?.warn?.({ err: e }, 'leadlag paper step failed'); } }, tickMs);

  function normalizeSettings(settings) {
    return {
      leaderSymbol: String(settings?.leaderSymbol || 'BTCUSDT').toUpperCase(),
      followerSymbol: String(settings?.followerSymbol || 'ETHUSDT').toUpperCase(),
      leaderMovePct: Math.max(0.01, safeNum(settings?.leaderMovePct, 1)),
      followerTpPct: Math.max(0.01, safeNum(settings?.followerTpPct, 1)),
      followerSlPct: Math.max(0.01, safeNum(settings?.followerSlPct, 1)),
      allowShort: settings?.allowShort !== false,
      lagMs: Math.max(0, Math.trunc(safeNum(settings?.lagMs, 250))),
    };
  }

  function start({ presetId, mode = 'paper', settings = null } = {}) {
    if (state.status === 'RUNNING' || state.status === 'STARTING') return { ok: false };
    state.status = 'STARTING';
    state.executionMode = mode;
    state.startedAt = null;
    state.endedAt = null;
    state.ticks = 0;
    state.positions = [];
    state.pendingSignal = null;
    state.lastNoEntryReasons = [];
    state.settings = normalizeSettings(settings || {});
    state.manual = { ...state.manual, enabled: true, ...state.settings, leaderBaseline: null, leaderPrice: null, followerPrice: null, leaderMovePctNow: 0 };
    state.currentRunKey = `${Date.now()}::${runKeyFromSettings(state.settings)}`;
    state.currentTradeEvents = [];
    upsertHistory(state.currentRunKey);
    state.activePresetId = presetId || presetsStore?.getState()?.activePresetId || null;
    const clone = presetsStore?.clonePresetAsSession?.(state.activePresetId);
    state.sessionPresetId = clone?.id || null;
    setTimeout(() => { state.status = 'RUNNING'; state.startedAt = now(); emitLeadLag('leadlag.state', getState()); }, 10);
    return { ok: true };
  }

  function stop({ reason = 'manual' } = {}) {
    if (state.status === 'STOPPED' || state.status === 'STOPPING') return { ok: false };
    state.status = 'STOPPING';
    setTimeout(() => { state.status = 'STOPPED'; state.endedAt = now(); state.pendingSignal = null; state.positions = []; pushLog('info', `Stopped (${reason})`); emitLeadLag('leadlag.state', getState()); }, 10);
    return { ok: true };
  }

  function reset() {
    state.status = 'STOPPED'; state.startedAt = null; state.endedAt = now(); state.ticks = 0;
    state.pendingSignal = null; state.positions = []; state.currentTradeEvents = []; state.currentRunKey = null; state.runHistory = {};
    state.lastNoEntryReasons = [];
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0, feeRateMaker: 0.0002 };
    trades = []; logs = [];
    emitLeadLag('leadlag.state', getState());
    return { ok: true };
  }

  function setSearchRows(rows = []) {
    if (!state.currentRunKey) return;
    const hist = upsertHistory(state.currentRunKey);
    const match = rows.find((r) => String(r?.leader) === state.settings?.leaderSymbol && String(r?.follower) === state.settings?.followerSymbol);
    hist.confirmations = Number(match?.confirmations || hist.confirmations || 0);
  }

  function getState({ includeHistory = true } = {}) {
    const base = { ...state, position: state.positions[0] || null, activePreset: presetsStore?.getPresetById(state.activePresetId) || null, sessionPreset: presetsStore?.getPresetById(state.sessionPresetId) || null };
    if (includeHistory) {
      base.trades = trades.slice(0, 100);
      base.logs = logs.slice(0, 200);
      base.runSummary = Object.values(state.runHistory).map((r) => ({ ...r, winRate: r.trades ? (r.wins / r.trades) * 100 : 0 }));
    }
    return base;
  }

  return { start, stop, reset, setSearchRows, getState, dispose: () => clearInterval(timer) };
}

import { createLeadLagAutoTune } from './leadlagAutoTune.js';

function safeNum(x, fallback = null) { const n = Number(x); return Number.isFinite(n) ? n : fallback; }
const MAX_POSITIONS = 5;
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const ENTRY_USD = 100;
const LEVERAGE = 10;
const AUTO_LAG_OPTIONS = [250, 500, 750, 1000];

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

export function createPaperTest({ getLeadLagTop, getMarketTicker = () => null, getUniverseSymbols = () => [], logger = console, onEvent = () => {}, tickMs = 250 } = {}) {
  const autoTune = createLeadLagAutoTune({ maxLogEntries: 200 });
  const state = {
    status: 'STOPPED', startedAt: null, endedAt: null, ticks: 0,
    lastLeadLagTop: [], lastNoEntryReasons: [],
    settings: null, executionMode: 'paper',
    autoTuneEnabled: true,
    pendingSignal: null, positions: [],
    stats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0, feeRateMaker: 0.0002 },
    manual: { enabled: false, leaderSymbol: null, followerSymbol: null, leaderMovePct: 0.1, followerTpPct: 0.1, followerSlPct: 0.1, allowShort: true, lagMs: 250, leaderBaseline: null, leaderPrice: null, followerPrice: null, leaderMovePctNow: 0, lastNoEntryReason: null },
    currentRunKey: null, currentTradeEvents: [], runHistory: {},
    currentConfigKey: null,
    lastEvaluation: null,
    tuningStatus: 'idle',
  };
  let logs = [];
  let trades = [];
  let tickTimer = null;
  let lastStateEmitAt = 0;
  const autoLag = {
    lastLeaderPx: null,
    lastFollowerPx: null,
    leaderReturns: new Map(),
    lagScores: new Map(AUTO_LAG_OPTIONS.map((lag) => [lag, 0])),
    lastEvalAt: 0,
    lastSwitchAt: 0,
    evalEveryMs: 10_000,
    switchCooldownMs: 30_000,
    minScoreDelta: 2,
    minRelativeGain: 1.2,
  };

  function resetAutoLag() {
    autoLag.lastLeaderPx = null;
    autoLag.lastFollowerPx = null;
    autoLag.leaderReturns.clear();
    autoLag.lagScores = new Map(AUTO_LAG_OPTIONS.map((lag) => [lag, 0]));
    autoLag.lastEvalAt = 0;
    autoLag.lastSwitchAt = 0;
  }

  function pushLeaderReturn(ts, value) {
    autoLag.leaderReturns.set(ts, value);
    if (autoLag.leaderReturns.size <= 8000) return;
    const entries = [...autoLag.leaderReturns.entries()].sort((a, b) => a[0] - b[0]);
    autoLag.leaderReturns = new Map(entries.slice(-4000));
  }

  function maybeApplyAutoLag(ts, followerRet, thresholdPct) {
    if (!Number.isFinite(followerRet)) return;
    for (const lag of AUTO_LAG_OPTIONS) {
      const leaderRet = autoLag.leaderReturns.get(ts - lag);
      if (!Number.isFinite(leaderRet)) continue;
      if (Math.abs(leaderRet) < thresholdPct || Math.abs(followerRet) < thresholdPct) continue;
      if (Math.sign(leaderRet) !== Math.sign(followerRet)) continue;
      autoLag.lagScores.set(lag, Number(autoLag.lagScores.get(lag) || 0) + 1);
    }

    if (ts - autoLag.lastEvalAt < autoLag.evalEveryMs) return;
    autoLag.lastEvalAt = ts;
    const currentLag = Number(state?.settings?.lagMs || 250);
    const currentScore = Number(autoLag.lagScores.get(currentLag) || 0);
    const ranked = [...autoLag.lagScores.entries()].sort((a, b) => b[1] - a[1]);
    const [bestLag, bestScore] = ranked[0] || [currentLag, currentScore];
    if (!AUTO_LAG_OPTIONS.includes(bestLag)) return;
    if (bestLag === currentLag) return;
    if (ts - autoLag.lastSwitchAt < autoLag.switchCooldownMs) return;
    const absWin = bestScore - currentScore;
    const relWin = currentScore > 0 ? bestScore / currentScore : (bestScore > 0 ? Infinity : 1);
    if (absWin < autoLag.minScoreDelta && relWin < autoLag.minRelativeGain) return;

    state.settings = { ...(state.settings || {}), lagMs: bestLag, lastAutoTuneAt: ts };
    state.manual = { ...(state.manual || {}), lagMs: bestLag };
    autoLag.lastSwitchAt = ts;
    pushLog('info', `AUTO_LAG switched lag ${currentLag} -> ${bestLag}`, { reason: 'AUTO_LAG', currentScore, bestScore });
    emitLeadLag('leadlag.settingsUpdated', { settings: state.settings, lagMs: bestLag, reason: 'AUTO_LAG' });
  }

  function emit(type, payload) { try { onEvent({ type, payload }); } catch {} }
  function emitLeadLag(type, payload) { emit(type, payload); emit(type.replace('leadlag.', 'paper.'), payload); }
  function pushLog(level, msg, extra = {}) { const row = { ts: now(), level, msg, ...extra }; logs.unshift(row); logs = logs.slice(0, 300); emitLeadLag('leadlag.log', row); }
  function getTicker(symbol) { return getMarketTicker(symbol, 'BT'); }
  function emitStateSnapshot(force = false) {
    const ts = now();
    if (!force && (ts - lastStateEmitAt) < 500) return;
    lastStateEmitAt = ts;
    emitLeadLag('leadlag.state', getState({ includeHistory: false }));
  }


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
    const qty = Math.max(0.0001, ((ENTRY_USD * LEVERAGE) / execPx));
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

    const row = { ts: now(), event: 'CLOSE', symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice, exitPrice: actualExit, theoreticalExit, pnlUSDT: pnl, feesUSDT: feeExit + pos.feeEntry, fundingUSDT: funding, slippageUSDT: slippage, reason: hitTp ? 'TP' : 'SL', runKey: state.currentRunKey, qty: pos.qty, openedAt: pos.openedAt };
    trades.unshift(row); trades = trades.slice(0, 300);
    state.currentTradeEvents.unshift(row); state.currentTradeEvents = state.currentTradeEvents.slice(0, 20);
    emitLeadLag('leadlag.trade', row);

    const hist = upsertHistory(state.currentRunKey);
    hist.trades += 1; if (pnl >= 0) hist.wins += 1; else hist.losses += 1;
    hist.pnlUSDT += pnl; hist.feesUSDT += feeExit + pos.feeEntry; hist.fundingUSDT += funding; hist.slippageUSDT += slippage;

    const tuneResult = autoTune.onTradeClosed({ settings: state.settings || {}, trade: row });
    const perConfigState = autoTune.getPerConfigState(tuneResult?.configKey);
    if (tuneResult?.metrics) state.lastEvaluation = tuneResult.metrics;
    if (tuneResult?.configKey) state.currentConfigKey = tuneResult.configKey;
    state.tuningStatus = perConfigState?.tuningStatus || tuneResult?.tuningStatus || 'idle';
    if (tuneResult?.changed) {
      if (Number.isFinite(Number(tuneResult?.newTpPct))) {
        state.settings = {
          ...(state.settings || {}),
          followerTpPct: Number(tuneResult.newTpPct),
          tpSource: 'auto',
          lastAutoTuneAt: now(),
        };
        state.manual = { ...(state.manual || {}), followerTpPct: state.settings.followerTpPct };
      }
      if (Number.isFinite(Number(tuneResult?.newLagMs))) {
        state.settings = {
          ...(state.settings || {}),
          lagMs: Number(tuneResult.newLagMs),
          lastAutoTuneAt: now(),
        };
        state.manual = { ...(state.manual || {}), lagMs: state.settings.lagMs };
      }
      emitLeadLag('leadlag.settingsUpdated', { settings: state.settings, reason: tuneResult?.decision || 'AUTO_TUNE' });
    }
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

    const fr = safeNum(followerTicker?.funding, safeNum(followerTicker?.fundingRate, 0));

    const retTs = Math.floor(now() / 250) * 250;
    if (Number.isFinite(leaderPx) && Number.isFinite(autoLag.lastLeaderPx) && autoLag.lastLeaderPx > 0) {
      pushLeaderReturn(retTs, (leaderPx - autoLag.lastLeaderPx) / autoLag.lastLeaderPx);
    }
    const followerRet = Number.isFinite(followerPx) && Number.isFinite(autoLag.lastFollowerPx) && autoLag.lastFollowerPx > 0
      ? (followerPx - autoLag.lastFollowerPx) / autoLag.lastFollowerPx
      : null;
    if (Number.isFinite(followerRet)) maybeApplyAutoLag(retTs, followerRet, Math.max(0.0005, Number(s.leaderMovePct || 0.1) / 100));
    autoLag.lastLeaderPx = Number.isFinite(leaderPx) ? leaderPx : autoLag.lastLeaderPx;
    autoLag.lastFollowerPx = Number.isFinite(followerPx) ? followerPx : autoLag.lastFollowerPx;
    const remaining = [];
    for (const p of state.positions) {
      if (!Number.isFinite(followerPx)) { remaining.push(p); continue; }
      const closed = maybeClosePosition(p, followerPx, fr);
      if (!closed) remaining.push(p);
    }
    state.positions = remaining;

    emitStateSnapshot(false);
  }

  function normalizeSettings(settings) {
    const allowedLagMs = AUTO_LAG_OPTIONS;
    const lagIn = Math.trunc(safeNum(settings?.lagMs, 250));
    const lagMs = allowedLagMs.includes(lagIn)
      ? lagIn
      : allowedLagMs.reduce((best, val) => (Math.abs(val - lagIn) < Math.abs(best - lagIn) ? val : best), 250);
    return {
      leaderSymbol: String(settings?.leaderSymbol || 'BTCUSDT').toUpperCase(),
      followerSymbol: String(settings?.followerSymbol || 'ETHUSDT').toUpperCase(),
      leaderMovePct: Math.max(0.01, safeNum(settings?.leaderMovePct, 0.1)),
      followerTpPct: Math.max(0.01, safeNum(settings?.followerTpPct, 0.1)),
      followerSlPct: Math.max(0.01, safeNum(settings?.followerSlPct, 0.1)),
      allowShort: settings?.allowShort !== false,
      lagMs,
      entryUsd: ENTRY_USD,
      leverage: LEVERAGE,
      tpSource: settings?.tpSource === 'auto' ? 'auto' : 'manual',
      lastAutoTuneAt: Number.isFinite(Number(settings?.lastAutoTuneAt)) ? Number(settings.lastAutoTuneAt) : null,
    };
  }

  function start({ mode = 'paper', settings = null } = {}) {
    if (state.status === 'RUNNING' || state.status === 'STARTING') return { ok: false };
    state.status = 'STARTING';
    state.executionMode = mode;
    state.startedAt = null;
    state.endedAt = null;
    state.ticks = 0;
    state.positions = [];
    state.pendingSignal = null;
    state.lastNoEntryReasons = [];
    resetAutoLag();
    state.settings = normalizeSettings(settings || {});
    state.autoTuneEnabled = autoTune.getAutoTuneConfig().enabled;
    state.manual = { ...state.manual, enabled: true, ...state.settings, leaderBaseline: null, leaderPrice: null, followerPrice: null, leaderMovePctNow: 0 };
    state.currentRunKey = `${Date.now()}::${runKeyFromSettings(state.settings)}`;
    state.currentConfigKey = autoTune.buildConfigKey(state.settings);
    state.lastEvaluation = null;
    state.tuningStatus = 'idle';
    state.currentTradeEvents = [];
    upsertHistory(state.currentRunKey);
    if (tickTimer) clearInterval(tickTimer);
    setTimeout(() => {
      state.status = 'RUNNING';
      state.startedAt = now();
      lastStateEmitAt = 0;
      tickTimer = setInterval(() => { try { step(); } catch (e) { logger?.warn?.({ err: e }, 'leadlag paper step failed'); } }, tickMs);
      emitStateSnapshot(true);
    }, 10);
    return { ok: true };
  }

  function stop({ reason = 'manual' } = {}) {
    if (state.status === 'STOPPED' || state.status === 'STOPPING') return { ok: false };
    state.status = 'STOPPING';
    setTimeout(() => {
      state.status = 'STOPPED';
      state.endedAt = now();
      state.pendingSignal = null;
      state.positions = [];
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      resetAutoLag();
      pushLog('info', `Stopped (${reason})`);
      emitStateSnapshot(true);
    }, 10);
    return { ok: true };
  }

  function reset() {
    state.status = 'STOPPED'; state.startedAt = null; state.endedAt = now(); state.ticks = 0;
    state.pendingSignal = null; state.positions = []; state.currentTradeEvents = []; state.currentRunKey = null; state.runHistory = {};
    state.lastNoEntryReasons = [];
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0, feeRateMaker: 0.0002 };
    state.currentConfigKey = null;
    state.lastEvaluation = null;
    state.tuningStatus = 'idle';
    resetAutoLag();
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    trades = []; logs = [];
    autoTune.reset();
    emitStateSnapshot(true);
    return { ok: true };
  }

  function setAutoTuneConfig(nextConfig = {}) {
    const cfg = autoTune.setAutoTuneConfig(nextConfig);
    state.autoTuneEnabled = cfg.enabled;
    return getState({ includeHistory: false });
  }

  function clearLearningLog() {
    autoTune.clearLearningLog();
    return getState({ includeHistory: false });
  }

  function setSearchRows(rows = []) {
    if (!state.currentRunKey) return;
    const hist = upsertHistory(state.currentRunKey);
    const match = rows.find((r) => String(r?.leader) === state.settings?.leaderSymbol && String(r?.follower) === state.settings?.followerSymbol);
    hist.confirmations = Number(match?.confirmations || hist.confirmations || 0);
  }

  function getState({ includeHistory = true } = {}) {
    const base = { ...state, position: state.positions[0] || null };
    base.autoTuneEnabled = autoTune.getAutoTuneConfig().enabled;
    base.autoTuneConfig = autoTune.getAutoTuneConfig();
    base.learningLog = autoTune.getLearningLog();
    base.perConfigLearningState = state.currentConfigKey ? autoTune.getPerConfigState(state.currentConfigKey) : null;
    base.currentClosedTrades = trades
      .filter((t) => String(t?.event || '').toUpperCase() === 'CLOSE' && t?.runKey === state.currentRunKey && String(t?.symbol || '').toUpperCase() === String(state?.settings?.followerSymbol || '').toUpperCase())
      .slice(0, 50)
      .map((t) => ({
        closedAt: Number(t?.ts || 0) || null,
        side: t?.side || null,
        entryPrice: Number(t?.entryPrice || 0) || null,
        exitPrice: Number(t?.exitPrice || 0) || null,
        qty: Number(t?.qty || 0) || null,
        pnl: Number(t?.pnlUSDT || 0) || 0,
        fees: Number(t?.feesUSDT || 0) || 0,
        funding: Number(t?.fundingUSDT || 0) || 0,
        slippage: Number(t?.slippageUSDT || 0) || 0,
        reason: t?.reason || null,
        durationSec: Number.isFinite(Number(t?.ts || 0)) && Number.isFinite(Number(t?.openedAt || 0)) && Number(t.openedAt) > 0 ? Math.max(0, (Number(t.ts) - Number(t.openedAt)) / 1000) : null,
      }));
    if (includeHistory) {
      base.trades = trades.slice(0, 100);
      base.logs = logs.slice(0, 200);
      base.runSummary = Object.values(state.runHistory).map((r) => ({ ...r, winRate: r.trades ? (r.wins / r.trades) * 100 : 0 }));
    }
    return base;
  }

  return { start, stop, reset, setSearchRows, setAutoTuneConfig, clearLearningLog, getState, dispose: () => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; } };
}

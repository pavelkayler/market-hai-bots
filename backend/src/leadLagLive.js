function safeNum(x, fallback = null) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function pickPx(t) {
  const mark = safeNum(t?.mark, null);
  if (Number.isFinite(mark) && mark > 0) return mark;
  const mid = safeNum(t?.mid, null);
  if (Number.isFinite(mid) && mid > 0) return mid;
  const last = safeNum(t?.last, safeNum(t?.lastPrice, null));
  return Number.isFinite(last) && last > 0 ? last : null;
}

function normalizeSettings(settings = {}) {
  return {
    leaderSymbol: String(settings?.leaderSymbol || 'BTCUSDT').toUpperCase(),
    followerSymbol: String(settings?.followerSymbol || 'ETHUSDT').toUpperCase(),
    leaderMovePct: Math.max(0.01, safeNum(settings?.leaderMovePct, 0.1)),
    followerTpPct: Math.max(0.01, safeNum(settings?.followerTpPct, 0.1)),
    followerSlPct: Math.max(0.01, safeNum(settings?.followerSlPct, 0.1)),
    allowShort: settings?.allowShort !== false,
    lagMs: Math.max(250, safeNum(settings?.lagMs, 250)),
    entryUsd: Math.max(1, safeNum(settings?.entryUsd, 100)),
    leverage: Math.max(1, safeNum(settings?.leverage, 10)),
  };
}

export function createLeadLagLive({ marketData, tradeExecutor, logger = console, onEvent = () => {}, tickMs = 250, pollMs = 2000 } = {}) {
  const state = {
    status: 'STOPPED',
    startedAt: null,
    endedAt: null,
    settings: null,
    executionMode: 'paper',
    positions: [],
    exchangeOrders: [],
    exchangeClosedPnl: [],
    currentTradeEvents: [],
    currentClosedTrades: [],
    lastNoEntryReasons: [],
    stats: { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0 },
    manual: { leaderBaseline: null, leaderMovePctNow: 0, leaderPrice: null, followerPrice: null, lastNoEntryReason: null },
    runKey: null,
  };

  let tickTimer = null;
  let pollTimer = null;
  let pendingSignal = null;
  let stopRequested = false;
  const seenClosed = new Set();

  function emit(type, payload) {
    try { onEvent({ type, payload }); } catch {}
  }

  function emitState(force = false) {
    if (force || state.status === 'RUNNING' || state.status === 'STARTING' || state.status === 'STOPPED') {
      emit('leadlag.state', getState({ includeHistory: false }));
    }
  }

  function pushEvent(row) {
    state.currentTradeEvents.unshift(row);
    state.currentTradeEvents = state.currentTradeEvents.slice(0, 20);
    emit('leadlag.trade', row);
  }

  function pushLog(level, msg, extra = {}) {
    emit('leadlag.log', { ts: Date.now(), level, msg, ...extra });
  }

  function getFollowerState() {
    const symbol = state?.settings?.followerSymbol;
    const exchangePos = (state.positions || []).find((r) => String(r?.symbol || '').toUpperCase() === symbol);
    return exchangePos || null;
  }

  async function syncExchangeOnce(symbolOverride = null) {
    if (!tradeExecutor?.enabled?.()) return;
    const symbol = symbolOverride || state?.settings?.followerSymbol;
    if (!symbol) return;
    try {
      const [positions, orders, closedPnl] = await Promise.all([
        tradeExecutor.getPositions({ symbol }),
        tradeExecutor.getOpenOrders({ symbol }),
        tradeExecutor.getClosedPnl({ symbol, limit: 50 }),
      ]);
      state.positions = (Array.isArray(positions) ? positions : []).slice(0, 5);
      state.exchangeOrders = (Array.isArray(orders) ? orders : []).slice(0, 50);
      state.exchangeClosedPnl = (Array.isArray(closedPnl) ? closedPnl : []).slice(0, 50);

      for (const row of state.exchangeClosedPnl) {
        const key = String(row?.orderId || row?.execId || row?.createdTime || row?.updatedTime || Math.random());
        if (seenClosed.has(key)) continue;
        seenClosed.add(key);
        const closedAt = Number(row?.updatedTime || row?.createdTime || Date.now());
        const side = String(row?.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
        const closeRow = {
          ts: closedAt,
          event: 'CLOSE',
          symbol: row?.symbol || symbol,
          side,
          entryPrice: safeNum(row?.avgEntryPrice, null),
          exitPrice: safeNum(row?.avgExitPrice, safeNum(row?.execPrice, null)),
          pnlUSDT: safeNum(row?.closedPnl, 0),
          feesUSDT: Math.abs(safeNum(row?.openFee, 0)) + Math.abs(safeNum(row?.closeFee, 0)),
          fundingUSDT: safeNum(row?.fillCountValue, 0),
          slippageUSDT: 0,
          reason: 'EXCHANGE',
          qty: safeNum(row?.closedSize, safeNum(row?.qty, 0)),
          openedAt: Number(row?.createdTime || closedAt),
          runKey: state.runKey,
        };
        state.currentClosedTrades.unshift({
          closedAt: closeRow.ts,
          side: closeRow.side,
          entryPrice: closeRow.entryPrice,
          exitPrice: closeRow.exitPrice,
          qty: closeRow.qty,
          pnl: closeRow.pnlUSDT,
          fees: closeRow.feesUSDT,
          funding: closeRow.fundingUSDT,
          slippage: closeRow.slippageUSDT,
          reason: closeRow.reason,
          durationSec: Number.isFinite(closeRow.openedAt) ? Math.max(0, (closeRow.ts - closeRow.openedAt) / 1000) : null,
        });
        state.currentClosedTrades = state.currentClosedTrades.slice(0, 50);
        pushEvent(closeRow);
        state.stats.trades += 1;
        if (closeRow.pnlUSDT >= 0) state.stats.wins += 1;
        else state.stats.losses += 1;
        state.stats.pnlUSDT += closeRow.pnlUSDT;
        state.stats.feesUSDT += closeRow.feesUSDT;
        state.stats.fundingUSDT += closeRow.fundingUSDT;
        state.stats.winRate = state.stats.trades > 0 ? (state.stats.wins / state.stats.trades) * 100 : 0;
      }

      emitState(false);
    } catch (err) {
      pushLog('warn', 'sync exchange failed', { err: err?.message || String(err) });
    }
  }

  async function evaluateEntry() {
    if (state.status !== 'RUNNING' || stopRequested) return;
    const s = state.settings || {};
    const leaderPx = pickPx(marketData.getTicker(s.leaderSymbol, 'BT'));
    const followerPx = pickPx(marketData.getTicker(s.followerSymbol, 'BT'));
    state.manual.leaderPrice = leaderPx;
    state.manual.followerPrice = followerPx;

    if (!Number.isFinite(state.manual.leaderBaseline) && Number.isFinite(leaderPx)) state.manual.leaderBaseline = leaderPx;
    if (Number.isFinite(leaderPx) && Number.isFinite(state.manual.leaderBaseline) && state.manual.leaderBaseline > 0) {
      state.manual.leaderMovePctNow = ((leaderPx - state.manual.leaderBaseline) / state.manual.leaderBaseline) * 100;
    }

    if (!Number.isFinite(leaderPx) || !Number.isFinite(followerPx) || !Number.isFinite(state.manual.leaderBaseline) || state.manual.leaderBaseline <= 0) return;
    if (pendingSignal) return;
    const movePct = ((leaderPx - state.manual.leaderBaseline) / state.manual.leaderBaseline) * 100;
    if (Math.abs(movePct) < s.leaderMovePct) return;

    const side = movePct >= 0 ? 'LONG' : 'SHORT';
    if (side === 'SHORT' && !s.allowShort) {
      state.lastNoEntryReasons = ['SHORT_DISABLED'];
      state.manual.lastNoEntryReason = 'SHORT_DISABLED';
      return;
    }

    const currentPos = getFollowerState();
    if (currentPos) {
      state.lastNoEntryReasons = ['EXCHANGE_POSITION_EXISTS'];
      state.manual.lastNoEntryReason = 'EXCHANGE_POSITION_EXISTS';
      return;
    }

    const orderSide = side === 'LONG' ? 'Buy' : 'Sell';
    const qty = (s.entryUsd * s.leverage) / followerPx;
    const slPrice = side === 'LONG' ? followerPx * (1 - s.followerSlPct / 100) : followerPx * (1 + s.followerSlPct / 100);
    const tpPrice = side === 'LONG' ? followerPx * (1 + s.followerTpPct / 100) : followerPx * (1 - s.followerTpPct / 100);

    pendingSignal = { side, ts: Date.now() };
    try {
      const openRes = await tradeExecutor.openPosition({
        symbol: s.followerSymbol,
        side: orderSide,
        qty,
        leverage: s.leverage,
        slPrice,
        tps: [{ price: tpPrice }],
      });
      pushEvent({ ts: Date.now(), event: 'OPEN', symbol: s.followerSymbol, side, entryPrice: followerPx, qty, runKey: state.runKey, exchange: openRes || null });
      state.manual.leaderBaseline = leaderPx;
    } catch (err) {
      const reason = err?.message || 'ENTRY_FAILED';
      state.lastNoEntryReasons = [reason];
      state.manual.lastNoEntryReason = reason;
      pushLog('warn', 'live entry rejected', { reason });
    } finally {
      pendingSignal = null;
    }
  }

  function clearTimers() {
    if (tickTimer) clearInterval(tickTimer);
    if (pollTimer) clearInterval(pollTimer);
    tickTimer = null;
    pollTimer = null;
  }

  function startLoops() {
    clearTimers();
    tickTimer = setInterval(() => { evaluateEntry().catch(() => {}); }, tickMs);
    pollTimer = setInterval(() => { syncExchangeOnce().catch(() => {}); }, pollMs);
  }

  function validateStart(executionMode) {
    if (!['demo', 'real'].includes(executionMode)) return { ok: false, reason: 'LIVE_MODE_REQUIRED' };
    if (!tradeExecutor?.enabled?.()) return { ok: false, reason: 'TRADE_DISABLED' };
    const baseUrl = String(process.env.BYBIT_TRADE_BASE_URL || 'https://api-demo.bybit.com');
    if (executionMode === 'real') {
      if (process.env.TRADE_REAL_ENABLED !== '1' || process.env.I_UNDERSTAND_REAL_RISK !== '1') return { ok: false, reason: 'REAL_SAFETY_GATING_REQUIRED' };
    }
    if (executionMode === 'demo' && !/api-demo\.bybit\.com/i.test(baseUrl)) return { ok: false, reason: 'DEMO_BASE_URL_REQUIRED' };
    return { ok: true };
  }

  async function start({ settings, executionMode } = {}) {
    if (state.status === 'RUNNING' || state.status === 'STARTING') return { ok: false, reason: 'ALREADY_RUNNING' };
    const checked = validateStart(executionMode);
    if (!checked.ok) return checked;
    state.status = 'STARTING';
    state.settings = normalizeSettings(settings);
    state.executionMode = executionMode;
    state.startedAt = null;
    state.endedAt = null;
    state.runKey = `${Date.now()}::${state.settings.leaderSymbol}/${state.settings.followerSymbol}`;
    state.lastNoEntryReasons = [];
    state.currentTradeEvents = [];
    state.currentClosedTrades = [];
    state.positions = [];
    state.exchangeOrders = [];
    state.exchangeClosedPnl = [];
    state.manual = { leaderBaseline: null, leaderMovePctNow: 0, leaderPrice: null, followerPrice: null, lastNoEntryReason: null };
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0 };
    seenClosed.clear();
    stopRequested = false;
    await syncExchangeOnce(state.settings.followerSymbol);
    startLoops();
    state.status = 'RUNNING';
    state.startedAt = Date.now();
    emitState(true);
    return { ok: true };
  }

  async function stop({ reason = 'manual', closePosition = true } = {}) {
    stopRequested = true;
    clearTimers();
    if (state.settings?.followerSymbol && tradeExecutor?.enabled?.()) {
      try {
        if (closePosition) await tradeExecutor.panicClose({ symbol: state.settings.followerSymbol });
        else await tradeExecutor.cancelAll({ symbol: state.settings.followerSymbol });
      } catch (err) {
        pushLog('warn', 'stop cleanup failed', { err: err?.message || String(err) });
      }
      await syncExchangeOnce(state.settings.followerSymbol);
    }
    state.status = 'STOPPED';
    state.endedAt = Date.now();
    pendingSignal = null;
    pushLog('info', `Stopped (${reason})`, { closePosition });
    if (!closePosition) pushLog('warn', 'Exposure remains open after stop', { symbol: state.settings?.followerSymbol });
    emitState(true);
    return { ok: true };
  }

  async function reset() {
    await stop({ reason: 'reset', closePosition: true });
    state.startedAt = null;
    state.endedAt = Date.now();
    state.settings = null;
    state.runKey = null;
    state.positions = [];
    state.exchangeOrders = [];
    state.exchangeClosedPnl = [];
    state.currentTradeEvents = [];
    state.currentClosedTrades = [];
    state.lastNoEntryReasons = [];
    state.stats = { trades: 0, wins: 0, losses: 0, pnlUSDT: 0, winRate: 0, feesUSDT: 0, fundingUSDT: 0, slippageUSDT: 0 };
    state.manual = { leaderBaseline: null, leaderMovePctNow: 0, leaderPrice: null, followerPrice: null, lastNoEntryReason: null };
    emitState(true);
    return { ok: true };
  }

  function getState({ includeHistory = false } = {}) {
    const out = {
      ...state,
      currentTradeEvents: state.currentTradeEvents.slice(0, 20),
      currentClosedTrades: state.currentClosedTrades.slice(0, 50),
      positions: state.positions.slice(0, 5),
      lastNoEntryReasons: state.lastNoEntryReasons.slice(0, 5),
      manual: { ...state.manual, leaderSymbol: state?.settings?.leaderSymbol || null, followerSymbol: state?.settings?.followerSymbol || null },
    };
    if (includeHistory) out.exchangeOrders = state.exchangeOrders.slice(0, 50);
    return out;
  }

  return {
    start,
    stop,
    reset,
    getState,
    syncNow: async ({ symbol } = {}) => {
      await syncExchangeOnce(symbol || state?.settings?.followerSymbol || null);
      return { ok: true, symbol: symbol || state?.settings?.followerSymbol || null, positions: state.positions, orders: state.exchangeOrders };
    },
    dispose: clearTimers,
  };
}

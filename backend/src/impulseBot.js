function now() { return Date.now(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function makeLog(level, msg, meta) {
  return { t: now(), level, msg, meta };
}

export function createImpulseBot({
  getSymbols = () => [],
  getCapsUniverse = () => [],
  getCandles,
  getOi,
  logger = console,
  onEvent = () => {},
} = {}) {
  const state = {
    status: 'STOPPED',
    startedAt: null,
    endedAt: null,
    mode: 'paper',
    settings: {
      directionMode: 'AUTO',
      confirmA: true,
      confirmB: true,
      triggerPct15m: 0.05,
      confirmWindowMs: 4 * 60 * 1000,
      cooldownMs: 60 * 60 * 1000,
      maxUiSymbols: 30,
    },
    signals: [],
    trades: [],
    logs: [],
    cooldownsBySymbol: {},
    openPositionsBySymbol: {},
    watchlistSize: 0,
  };

  let timer = null;
  let idx = 0;

  function emit(type, payload) { onEvent({ type, payload }); }
  function pushLog(level, msg, meta) {
    const row = makeLog(level, msg, meta);
    state.logs = [row, ...state.logs].slice(0, 400);
    emit('impulse.log', row);
  }
  function pushSignal(row) {
    state.signals = [row, ...state.signals].slice(0, 400);
    emit('impulse.signal', row);
  }
  function pushTrade(row) {
    state.trades = [row, ...state.trades].slice(0, 400);
    emit('impulse.trade', row);
  }

  function getState() {
    return {
      ...state,
      uiSymbols: getWatchlist().slice(0, state.settings.maxUiSymbols),
      activePositions: Object.values(state.openPositionsBySymbol || {}),
    };
  }

  function getWatchlist() {
    const feed = new Set((getSymbols() || []).map((s) => String(s || '').toUpperCase()));
    const capped = (getCapsUniverse() || []).map((s) => String(s || '').toUpperCase()).filter((s) => feed.has(s));
    return capped.slice(0, 500);
  }

  async function tick() {
    const list = getWatchlist();
    state.watchlistSize = list.length;
    if (!list.length) return;
    const symbol = list[idx % list.length];
    idx += 1;

    const cd = Number(state.cooldownsBySymbol[symbol] || 0);
    if (cd > now()) return;
    if (state.openPositionsBySymbol[symbol]) return;

    try {
      const candles = await getCandles({ symbol, interval: '15', limit: 2 });
      if (!Array.isArray(candles) || candles.length < 2) return;
      const a = candles[candles.length - 2];
      const b = candles[candles.length - 1];
      const from = num(a?.c);
      const to = num(b?.c);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return;
      const priceDelta15m = (to - from) / Math.abs(from);
      if (Math.abs(priceDelta15m) < state.settings.triggerPct15m) return;

      const oiRows = await getOi({ symbol, interval: '15', limit: 2 });
      const oiA = num(oiRows?.[0]?.oi);
      const oiB = num(oiRows?.[1]?.oi);
      const oiDelta15m = Number.isFinite(oiA) && Number.isFinite(oiB) && oiA !== 0 ? (oiB - oiA) / Math.abs(oiA) : 0;

      let side = priceDelta15m > 0 ? 'LONG' : 'SHORT';
      if (state.settings.directionMode === 'COUNTERTREND_ONLY') side = side === 'LONG' ? 'SHORT' : 'LONG';

      const signal = { ts: now(), symbol, side, priceDelta15m, oiDelta15m, mode: state.settings.directionMode };
      pushSignal(signal);

      const useA = state.settings.confirmA;
      const useB = state.settings.confirmB;
      if (!useA && !useB) {
        pushLog('info', 'NO_TRADE: confirmations disabled', { symbol });
        return;
      }

      // Simplified confirmation: reuse trigger candle close direction
      const confirmed = (useA || useB) && ((side === 'LONG' && to >= from) || (side === 'SHORT' && to <= from));
      if (!confirmed) {
        pushLog('info', 'NO_TRADE: confirmation failed', { symbol, priceDelta15m, oiDelta15m });
        return;
      }

      const entry = to;
      const tp = side === 'LONG' ? entry * 1.005 : entry * 0.995;
      const sl = side === 'LONG' ? entry * 0.995 : entry * 1.005;
      const position = { symbol, side, openedAt: now(), entry, tp, sl, mode: state.mode };
      state.openPositionsBySymbol[symbol] = position;
      pushTrade({ ts: now(), symbol, side, event: 'OPEN', entry, tp, sl, mode: state.mode });

      // close immediately on next 1m candle approximation (paper loop simplification)
      const c1 = await getCandles({ symbol, interval: '1', limit: 1 });
      const closePx = num(c1?.[0]?.c) || entry;
      const hitTp = side === 'LONG' ? closePx >= tp : closePx <= tp;
      const hitSl = side === 'LONG' ? closePx <= sl : closePx >= sl;
      const exitReason = hitTp ? 'TP' : hitSl ? 'SL' : 'TIME';
      const pnl = (side === 'LONG' ? (closePx - entry) : (entry - closePx)) * (100 / entry);
      delete state.openPositionsBySymbol[symbol];
      state.cooldownsBySymbol[symbol] = now() + state.settings.cooldownMs;
      pushTrade({ ts: now(), symbol, side, event: 'CLOSE', entry, exit: closePx, pnlUSDT: pnl, exitReason, roiPct: (pnl / 100) * 100 });
    } catch (e) {
      logger?.warn?.({ err: e }, 'impulse tick failed');
    }
  }

  function start({ mode = 'paper', settings = {} } = {}) {
    if (timer) return;
    state.mode = mode;
    state.settings = { ...state.settings, ...(settings || {}) };
    state.status = 'RUNNING';
    state.startedAt = now();
    state.endedAt = null;
    emit('impulse.status', getState());
    pushLog('info', `Impulse started (${mode})`, { settings: state.settings });
    timer = setInterval(() => { tick().catch(() => {}); }, 2000);
  }

  function stop({ reason = 'manual' } = {}) {
    if (timer) clearInterval(timer);
    timer = null;
    state.status = 'STOPPED';
    state.endedAt = now();
    emit('impulse.status', getState());
    pushLog('info', `Impulse stopped (${reason})`);
  }

  return { start, stop, getState };
}

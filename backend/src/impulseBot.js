function now() { return Date.now(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clampWindowSec(v) {
  const n = Number(v);
  if (n === 300 || n === 900 || n === 1800) return n;
  return 900;
}

function pickClosestAtOrBefore(rows, targetTs) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = null;
  for (const row of rows) {
    const ts = num(row?.t);
    if (!Number.isFinite(ts) || ts > targetTs) continue;
    if (!best || ts > best.t) best = row;
  }
  return best;
}

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
      windowSec: 15 * 60,
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
      const windowSec = clampWindowSec(state.settings.windowSec);
      const lookbackMs = windowSec * 1000;
      const targetTs = now() - lookbackMs;
      const candleLimit = Math.max(35, Math.ceil(windowSec / 60) + 10);
      const candles = await getCandles({ symbol, interval: '1', limit: candleLimit });
      if (!Array.isArray(candles) || !candles.length) return;
      const currentCandle = candles[candles.length - 1];
      const fromCandle = pickClosestAtOrBefore(candles, targetTs);
      const from = num(fromCandle?.c);
      const to = num(currentCandle?.c);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) {
        pushLog('info', 'NO_SIGNAL: insufficient history', { symbol, kind: 'price', windowSec });
        return;
      }
      const priceDeltaPct = (to - from) / Math.abs(from);
      if (Math.abs(priceDeltaPct) < state.settings.triggerPct15m) return;

      const oiLimit = Math.max(40, Math.ceil(windowSec / (5 * 60)) + 12);
      const oiRows = await getOi({ symbol, interval: '5', limit: oiLimit });
      const oiCurrent = oiRows?.[oiRows.length - 1] || null;
      const oiFrom = pickClosestAtOrBefore(oiRows, targetTs);
      const oiA = num(oiFrom?.oi);
      const oiB = num(oiCurrent?.oi);
      if (!Number.isFinite(oiA) || !Number.isFinite(oiB) || oiA === 0) {
        pushLog('info', 'NO_SIGNAL: insufficient history', { symbol, kind: 'oi', windowSec });
        return;
      }
      const oiDeltaPct = (oiB - oiA) / Math.abs(oiA);

      let side = priceDeltaPct > 0 ? 'LONG' : 'SHORT';
      if (state.settings.directionMode === 'COUNTERTREND_ONLY') side = side === 'LONG' ? 'SHORT' : 'LONG';

      const signal = {
        ts: now(),
        symbol,
        side,
        mode: state.settings.directionMode,
        windowSec,
        priceDeltaPct,
        oiDeltaPct,
        confirmation: { confirmA: !!state.settings.confirmA, confirmB: !!state.settings.confirmB },
      };
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
        pushLog('info', 'NO_TRADE: confirmation failed', { symbol, windowSec, priceDeltaPct, oiDeltaPct });
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
    state.settings = { ...state.settings, ...(settings || {}), windowSec: clampWindowSec(settings?.windowSec ?? state.settings.windowSec) };
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

  function setConfig(next = {}) {
    state.settings = { ...state.settings, ...(next || {}), windowSec: clampWindowSec(next?.windowSec ?? state.settings.windowSec) };
    emit('impulse.status', getState());
    pushLog('info', 'Impulse config updated', { windowSec: state.settings.windowSec, directionMode: state.settings.directionMode, confirmA: state.settings.confirmA, confirmB: state.settings.confirmB });
    return getState();
  }

  return { start, stop, setConfig, getState };
}

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { calcVol24h } from './momentumUtils.js';

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const ALLOWED_INTERVALS = new Set([1, 3, 5]);
const TURNOVER_HISTORY_SIZE = 20;

function chunk(arr, n = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function median(values = []) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export function createMomentumMarketData({ logger = console, cap = 1000, turnover24hMin = 5_000_000, vol24hMin = 0.1 } = {}) {
  const emitter = new EventEmitter();
  let ws = null;
  let connected = false;
  let lastTickTs = 0;
  let tickDriftMs = 0;
  const pending = new Map();
  const current = new Map();
  const ring = new Map();
  const instruments = new Set();
  const subscribedTickers = new Set();
  const subscribedKlines = new Set();
  const instrumentMeta = new Map();
  const activeIntervals = new Set([1]);
  const turnoverStore = new Map();
  const oiLastUpdateTsMs = new Map();

  const getTurnoverKey = (symbol, interval) => `${symbol}:${interval}`;

  function ensureAllowedIntervals(input = []) {
    const out = new Set();
    for (const v of input) {
      const n = Number(v);
      if (ALLOWED_INTERVALS.has(n)) out.add(n);
    }
    return out;
  }

  async function fetchUniverse() {
    let cursor = '';
    do {
      const url = new URL('https://api.bybit.com/v5/market/instruments-info');
      url.searchParams.set('category', 'linear');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url);
      const data = await res.json();
      const list = data?.result?.list || [];
      for (const row of list) {
        if (row?.contractType === 'LinearPerpetual' && row?.status === 'Trading' && row?.symbol?.endsWith('USDT')) {
          instruments.add(row.symbol);
          const tickSize = Number(row?.priceFilter?.tickSize);
          if (Number.isFinite(tickSize) && tickSize > 0) instrumentMeta.set(row.symbol, { tickSize });
        }
      }
      cursor = data?.result?.nextPageCursor || '';
    } while (cursor);
  }

  function upsertTurnover({ symbol, interval, candleStartMs, turnoverUSDT, updateMs }) {
    const key = getTurnoverKey(symbol, interval);
    const cur = turnoverStore.get(key) || {
      prevTurnoverUSDT: null,
      curTurnoverUSDT: null,
      curCandleStartMs: null,
      lastUpdateMs: 0,
      history: [],
      medianTurnoverUSDT: null,
    };
    if (cur.curCandleStartMs === null || candleStartMs > cur.curCandleStartMs) {
      if (cur.curCandleStartMs !== null && Number.isFinite(cur.curTurnoverUSDT)) {
        cur.prevTurnoverUSDT = cur.curTurnoverUSDT;
        cur.history.push(cur.curTurnoverUSDT);
        if (cur.history.length > TURNOVER_HISTORY_SIZE) cur.history.shift();
        cur.medianTurnoverUSDT = median(cur.history);
      }
      cur.curCandleStartMs = candleStartMs;
      cur.curTurnoverUSDT = turnoverUSDT;
    } else if (candleStartMs === cur.curCandleStartMs) {
      cur.curTurnoverUSDT = turnoverUSDT;
    }
    cur.lastUpdateMs = updateMs;
    turnoverStore.set(key, cur);
  }

  function parseKline(msg) {
    if (!msg?.topic?.startsWith('kline.')) return null;
    const parts = String(msg.topic).split('.');
    if (parts.length < 3) return null;
    const interval = Number(parts[1]);
    const symbol = parts[2];
    if (!ALLOWED_INTERVALS.has(interval) || !symbol) return null;
    const row = Array.isArray(msg.data) ? msg.data[0] : msg.data;
    if (!row) return null;
    const candleStartMs = Number(row.start ?? row.startTime);
    const turnoverUSDT = Number(row.turnover);
    if (!Number.isFinite(candleStartMs) || candleStartMs <= 0) return null;
    if (!Number.isFinite(turnoverUSDT) || turnoverUSDT < 0) return null;
    return { symbol, interval, candleStartMs, turnoverUSDT };
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.on('open', () => { connected = true; reconcileSubscriptions(); });
    ws.on('close', () => { connected = false; setTimeout(connect, 1500); });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg?.topic?.startsWith('tickers.')) {
          const symbol = msg.topic.slice(8);
          const d = msg?.data || {};
          const meta = instrumentMeta.get(symbol) || {};
          if (d.openInterest !== undefined) oiLastUpdateTsMs.set(symbol, Number(msg.ts || Date.now()));
          pending.set(symbol, {
            markPrice: Number(d.markPrice),
            openInterest: Number(d.openInterest),
            turnover24h: Number(d.turnover24h),
            highPrice24h: Number(d.highPrice24h),
            lowPrice24h: Number(d.lowPrice24h),
            price24hPcnt: Number(d.price24hPcnt),
            ts: Number(msg.ts || Date.now()),
            tickSize: Number(meta.tickSize) || null,
            oiLastUpdateTsMs: oiLastUpdateTsMs.get(symbol) || null,
          });
          return;
        }
        const k = parseKline(msg);
        if (k) upsertTurnover({ ...k, updateMs: Number(msg.ts || Date.now()) });
      } catch {}
    });
  }

  function onTick(now = Date.now()) {
    const sec = Math.floor(now / 1000);
    tickDriftMs = Math.abs(now - (sec * 1000));
    lastTickTs = now;
    for (const [symbol, snap] of pending.entries()) {
      current.set(symbol, snap);
      let bucket = ring.get(symbol);
      if (!bucket) bucket = { rows: [], secToIndex: new Map() };
      const rows = bucket.rows;
      rows.push({ tsSec: sec, markPrice: snap.markPrice, openInterest: snap.openInterest });
      bucket.secToIndex.set(sec, rows.length - 1);
      if (rows.length > 1000) {
        const first = rows.shift();
        bucket.secToIndex.delete(first.tsSec);
      }
      ring.set(symbol, bucket);
    }
    pending.clear();
    emitter.emit('tick', { ts: now, sec });
  }

  function getAtWindow(symbol, targetSec) {
    const bucket = ring.get(symbol);
    if (!bucket) return null;
    const idx = bucket.secToIndex.get(targetSec);
    if (idx === undefined) return null;
    return bucket.rows[idx] || null;
  }

  function getLastReturns(symbol, k) {
    const bucket = ring.get(symbol);
    const count = Math.max(1, Number(k) || 1);
    if (!bucket || bucket.rows.length < count + 1) return [];
    const rows = bucket.rows.slice(-(count + 1));
    const out = [];
    for (let i = 1; i < rows.length; i += 1) {
      const prev = Number(rows[i - 1].markPrice);
      const cur = Number(rows[i].markPrice);
      if (!(prev > 0) || !(cur > 0)) return [];
      out.push((cur / prev) - 1);
    }
    return out;
  }

  function getTrendOk(symbol, k, side) {
    const returns = getLastReturns(symbol, k);
    if (returns.length < k) return false;
    if (side === 'LONG') return returns.every((x) => x > 0);
    if (side === 'SHORT') return returns.every((x) => x < 0);
    return false;
  }

  function getEligibleSymbols({ turnoverMin = turnover24hMin, volMin = vol24hMin } = {}) {
    const rows = [];
    for (const sym of instruments) {
      const s = current.get(sym);
      if (!s) continue;
      const vol = calcVol24h(s).vol24h;
      if (!(Number(s.turnover24h) > turnoverMin) || !(vol >= volMin)) continue;
      rows.push({ symbol: sym, turnover24h: Number(s.turnover24h) || 0 });
    }
    rows.sort((a, b) => b.turnover24h - a.turnover24h);
    return rows.slice(0, cap).map((r) => r.symbol);
  }

  async function sendTopicOps(op, topics = []) {
    for (const c of chunk(topics, 100)) {
      ws.send(JSON.stringify({ op, args: c }));
      await new Promise((r) => setTimeout(r, 75));
    }
  }

  async function reconcileSubscriptions() {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const desiredSymbols = getEligibleSymbols();
    const desiredTickerTopics = new Set(desiredSymbols.map((s) => `tickers.${s}`));
    const desiredKlineTopics = new Set();
    for (const symbol of desiredSymbols) {
      for (const interval of activeIntervals) desiredKlineTopics.add(`kline.${interval}.${symbol}`);
    }

    const toSubTickers = [...desiredTickerTopics].filter((t) => !subscribedTickers.has(t));
    const toUnTickers = [...subscribedTickers].filter((t) => !desiredTickerTopics.has(t));
    await sendTopicOps('subscribe', toSubTickers);
    toSubTickers.forEach((t) => subscribedTickers.add(t));
    await sendTopicOps('unsubscribe', toUnTickers);
    toUnTickers.forEach((t) => subscribedTickers.delete(t));

    const toSubKlines = [...desiredKlineTopics].filter((t) => !subscribedKlines.has(t));
    const toUnKlines = [...subscribedKlines].filter((t) => !desiredKlineTopics.has(t));
    await sendTopicOps('subscribe', toSubKlines);
    toSubKlines.forEach((t) => subscribedKlines.add(t));
    await sendTopicOps('unsubscribe', toUnKlines);
    toUnKlines.forEach((t) => subscribedKlines.delete(t));
  }

  function getTurnoverGate(symbol, interval) {
    const nInterval = Number(interval);
    if (!ALLOWED_INTERVALS.has(nInterval)) return { prevTurnoverUSDT: null, curTurnoverUSDT: null, medianTurnoverUSDT: null, curCandleStartMs: null, ready: false };
    const row = turnoverStore.get(getTurnoverKey(symbol, nInterval));
    if (!row) return { prevTurnoverUSDT: null, curTurnoverUSDT: null, medianTurnoverUSDT: null, curCandleStartMs: null, ready: false };
    const ready = Number(row.prevTurnoverUSDT) > 0 && Number(row.curCandleStartMs) > 0;
    return { prevTurnoverUSDT: row.prevTurnoverUSDT, curTurnoverUSDT: row.curTurnoverUSDT, medianTurnoverUSDT: row.medianTurnoverUSDT, curCandleStartMs: row.curCandleStartMs, ready };
  }

  function setActiveIntervals(intervals = []) {
    const next = ensureAllowedIntervals(intervals);
    if (next.size === 0) next.add(1);
    activeIntervals.clear();
    for (const i of next) activeIntervals.add(i);
    reconcileSubscriptions().catch((e) => logger.warn?.({ err: e }, 'momentum active intervals reconcile failed'));
  }

  function getOiAgeSec(symbol) {
    const ts = oiLastUpdateTsMs.get(symbol);
    if (!(ts > 0)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (Date.now() - ts) / 1000);
  }

  function getOiValue(symbol) {
    return Number(current.get(symbol)?.openInterest || 0);
  }

  async function start() {
    await fetchUniverse();
    connect();
    setInterval(() => onTick(Date.now()), 1000);
    setInterval(() => { fetchUniverse().catch((e) => logger.warn?.({ err: e }, 'momentum universe refresh failed')); }, 15 * 60 * 1000);
    setInterval(() => { reconcileSubscriptions().catch((e) => logger.warn?.({ err: e }, 'momentum sub reconcile failed')); }, 45 * 1000);
  }

  return {
    start,
    onTick: (fn) => emitter.on('tick', fn),
    getSnapshot: (symbol) => current.get(symbol) || null,
    getAtWindow,
    getLastReturns,
    getTrendOk,
    getOiAgeSec,
    getOiValue,
    getEligibleSymbols,
    getTurnoverGate,
    setActiveIntervals,
    getStatus: () => ({
      wsConnected: connected,
      subscribedCount: subscribedTickers.size,
      eligibleCount: getEligibleSymbols().length,
      universeCount: instruments.size,
      cap,
      lastTickTs,
      tickDriftMs,
      activeIntervals: [...activeIntervals].sort((a, b) => a - b),
      klineSubscribedCount: subscribedKlines.size,
    }),
  };
}

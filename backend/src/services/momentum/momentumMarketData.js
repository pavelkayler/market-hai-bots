import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { calcVol24h } from './momentumUtils.js';

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';

function chunk(arr, n = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
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
  const subscribed = new Set();

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
        if (row?.contractType === 'LinearPerpetual' && row?.status === 'Trading' && row?.symbol?.endsWith('USDT')) instruments.add(row.symbol);
      }
      cursor = data?.result?.nextPageCursor || '';
    } while (cursor);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);
    ws.on('open', () => { connected = true; reconcileSubscriptions(); });
    ws.on('close', () => { connected = false; setTimeout(connect, 1500); });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (!msg?.topic?.startsWith('tickers.')) return;
        const symbol = msg.topic.slice(8);
        const d = msg?.data || {};
        pending.set(symbol, {
          markPrice: Number(d.markPrice),
          openInterest: Number(d.openInterest),
          turnover24h: Number(d.turnover24h),
          highPrice24h: Number(d.highPrice24h),
          lowPrice24h: Number(d.lowPrice24h),
          price24hPcnt: Number(d.price24hPcnt),
          ts: Number(msg.ts || Date.now()),
        });
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

  async function reconcileSubscriptions() {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const desired = new Set(getEligibleSymbols());
    const toSub = [...desired].filter((s) => !subscribed.has(s));
    const toUn = [...subscribed].filter((s) => !desired.has(s));
    for (const c of chunk(toSub, 100)) {
      ws.send(JSON.stringify({ op: 'subscribe', args: c.map((s) => `tickers.${s}`) }));
      c.forEach((s) => subscribed.add(s));
      await new Promise((r) => setTimeout(r, 75));
    }
    for (const c of chunk(toUn, 100)) {
      ws.send(JSON.stringify({ op: 'unsubscribe', args: c.map((s) => `tickers.${s}`) }));
      c.forEach((s) => subscribed.delete(s));
      await new Promise((r) => setTimeout(r, 75));
    }
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
    getEligibleSymbols,
    getStatus: () => ({ wsConnected: connected, subscribedCount: subscribed.size, eligibleCount: getEligibleSymbols().length, universeCount: instruments.size, cap, lastTickTs, tickDriftMs }),
  };
}

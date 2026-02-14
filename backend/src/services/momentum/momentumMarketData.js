import WebSocket from 'ws';
import { EventEmitter } from 'events';

const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
const ALLOWED_INTERVALS = new Set([1, 3, 5]);
const TURNOVER_HISTORY_SIZE = 20;
const MIN_SELECTION_CAP = 10;
const MAX_SELECTION_CAP = 1500;

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
  const universeSymbols = instruments;
  const subscribedTickers = new Set();
  const subscribedKlines = new Set();
  const instrumentMeta = new Map();
  const activeIntervals = new Set([1]);
  const turnoverStore = new Map();
  const oiLastUpdateTsMs = new Map();
  const tickers24h = new Map();
  let tickersSnapshotTsMs = 0;
  let tickersSnapshotCount = 0;
  let tickersSnapshotMissingFieldsCount = 0;
  let started = false;
  let bootstrapStartedAtMs = 0;
  const bootstrapGraceMs = 90_000;
  const minHoldSubscribedMs = 60_000;
  const subscribedAtMs = new Map();
  let lastEligibility = {
    eligibleCount: 0,
    ineligibleCounts: {
      NO_TICKER_SNAPSHOT: 0,
      MISSING_LASTPRICE: 0,
      MISSING_TURNOVER: 0,
      MISSING_VOL_FIELDS: 0,
      BELOW_TURNOVER_MIN: 0,
      BELOW_VOL_MIN: 0,
      NOT_IN_UNIVERSE: 0,
    },
  };
  const selectionPolicy = {
    cap: Math.max(MIN_SELECTION_CAP, Math.min(MAX_SELECTION_CAP, Math.trunc(Number(cap) || 200))),
    turnover24hMin: Math.max(0, Number(turnover24hMin) || 0),
    vol24hMin: Math.max(0, Number(vol24hMin) || 0),
  };

  const getTurnoverKey = (symbol, interval) => `${symbol}:${interval}`;

  const toNum = (x) => {
    const n = Number.parseFloat(x);
    return Number.isFinite(n) ? n : Number.NaN;
  };

  const isFiniteNum = (n) => Number.isFinite(n);

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
          const contractMultiplier = Number(row?.contractSize);
          if (Number.isFinite(tickSize) && tickSize > 0) {
            instrumentMeta.set(row.symbol, {
              tickSize,
              contractMultiplier: Number.isFinite(contractMultiplier) && contractMultiplier > 0 ? contractMultiplier : null,
            });
          }
        }
      }
      cursor = data?.result?.nextPageCursor || '';
    } while (cursor);
  }

  async function refreshTickersSnapshot() {
    let cursor = '';
    let count = 0;
    let missingFieldsCount = 0;
    do {
      const url = new URL('https://api.bybit.com/v5/market/tickers');
      url.searchParams.set('category', 'linear');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url);
      const data = await res.json();
      const list = data?.result?.list || [];
      for (const row of list) {
        const symbol = String(row?.symbol || '');
        if (!universeSymbols.has(symbol)) continue;
        const lastPrice = toNum(row.lastPrice ?? row.last);
        const markPrice = toNum(row.markPrice);
        const turnover24h = toNum(row.turnover24h);
        const highPrice24h = toNum(row.highPrice24h);
        const lowPrice24h = toNum(row.lowPrice24h);
        const price24hPcnt = toNum(row.price24hPcnt);
        if (!isFiniteNum(lastPrice) || !isFiniteNum(turnover24h)) missingFieldsCount += 1;
        tickers24h.set(symbol, {
          symbol,
          lastPrice,
          markPrice,
          turnover24h,
          highPrice24h,
          lowPrice24h,
          price24hPcnt,
          tsMs: Date.now(),
        });
        count += 1;
        const meta = instrumentMeta.get(symbol) || {};
        const openInterestQty = toNum(row.openInterest);
        const oiValueFromTicker = toNum(row.openInterestValue ?? row.openInterestValueUSDT ?? row.open_interest_value);
        const canDeriveOiValue = isFiniteNum(openInterestQty) && openInterestQty > 0
          && isFiniteNum(lastPrice) && lastPrice > 0
          && isFiniteNum(meta.contractMultiplier) && meta.contractMultiplier > 0;
        const oiValue = Number.isFinite(oiValueFromTicker) && oiValueFromTicker > 0
          ? oiValueFromTicker
          : (canDeriveOiValue ? (openInterestQty * lastPrice * meta.contractMultiplier) : null);
        const tsMs = Date.now();
        if (Number.isFinite(oiValue) && oiValue > 0) oiLastUpdateTsMs.set(symbol, tsMs);
        current.set(symbol, {
          markPrice,
          lastPrice,
          openInterestQty,
          oiValue,
          turnover24h: Number(row.turnover24h),
          highPrice24h: Number(row.highPrice24h),
          lowPrice24h: Number(row.lowPrice24h),
          price24hPcnt: Number(row.price24hPcnt),
          ts: tsMs,
          tickSize: Number(meta.tickSize) || null,
          contractMultiplier: Number(meta.contractMultiplier) || null,
          oiLastUpdateTsMs: oiLastUpdateTsMs.get(symbol) || null,
        });
      }
      cursor = data?.result?.nextPageCursor || '';
    } while (cursor);
    tickersSnapshotTsMs = Date.now();
    tickersSnapshotCount = count;
    tickersSnapshotMissingFieldsCount = missingFieldsCount;
    logger.info?.({ tickersSnapshotCount, tickersSnapshotMissingFieldsCount }, 'momentum tickers snapshot refreshed');
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
    ws.on('open', () => { connected = true; reconcileSubscriptions('wsOpen'); });
    ws.on('close', () => { connected = false; setTimeout(connect, 1500); });
    ws.on('message', (buf) => {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg?.topic?.startsWith('tickers.')) {
          const symbol = msg.topic.slice(8);
          const d = msg?.data || {};
          const meta = instrumentMeta.get(symbol) || {};
          const tsMs = Number(msg.ts || Date.now());
          const markPrice = toNum(d.markPrice);
          const lastPrice = toNum(d.lastPrice ?? d.last);
          const openInterestQty = toNum(d.openInterest);
          const oiValueFromTicker = toNum(d.openInterestValue ?? d.openInterestValueUSDT ?? d.open_interest_value);
          const canDeriveOiValue = isFiniteNum(openInterestQty) && openInterestQty > 0
            && isFiniteNum(lastPrice) && lastPrice > 0
            && isFiniteNum(meta.contractMultiplier) && meta.contractMultiplier > 0;
          const oiValue = Number.isFinite(oiValueFromTicker) && oiValueFromTicker > 0
            ? oiValueFromTicker
            : (canDeriveOiValue ? (openInterestQty * lastPrice * meta.contractMultiplier) : null);
          if (Number.isFinite(oiValue) && oiValue > 0) oiLastUpdateTsMs.set(symbol, tsMs);
          pending.set(symbol, {
            markPrice,
            lastPrice,
            openInterestQty,
            oiValue,
            turnover24h: toNum(d.turnover24h),
            highPrice24h: toNum(d.highPrice24h),
            lowPrice24h: toNum(d.lowPrice24h),
            price24hPcnt: toNum(d.price24hPcnt),
            ts: tsMs,
            tickSize: Number(meta.tickSize) || null,
            contractMultiplier: Number(meta.contractMultiplier) || null,
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
      rows.push({ tsSec: sec, markPrice: snap.markPrice, lastPrice: snap.lastPrice, oiValue: snap.oiValue, openInterestQty: snap.openInterestQty });
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
      const prev = Number(rows[i - 1].lastPrice);
      const cur = Number(rows[i].lastPrice);
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

  function getVolPctFromTicker(snap) {
    if (isFiniteNum(snap?.highPrice24h) && isFiniteNum(snap?.lowPrice24h) && snap.lowPrice24h > 0) {
      return ((snap.highPrice24h - snap.lowPrice24h) / snap.lowPrice24h) * 100;
    }
    if (isFiniteNum(snap?.price24hPcnt)) {
      const raw = Math.abs(snap.price24hPcnt);
      return raw <= 1.5 ? raw * 100 : raw;
    }
    return Number.NaN;
  }

  function getEligibleSymbols({ turnoverMin = selectionPolicy.turnover24hMin, volMin = selectionPolicy.vol24hMin, cap: limit = selectionPolicy.cap } = {}) {
    const ineligibleCounts = {
      NO_TICKER_SNAPSHOT: 0,
      MISSING_LASTPRICE: 0,
      MISSING_TURNOVER: 0,
      MISSING_VOL_FIELDS: 0,
      BELOW_TURNOVER_MIN: 0,
      BELOW_VOL_MIN: 0,
      NOT_IN_UNIVERSE: 0,
    };
    const rows = [];
    for (const sym of universeSymbols) {
      const s = tickers24h.get(sym);
      if (!s) {
        ineligibleCounts.NO_TICKER_SNAPSHOT += 1;
        continue;
      }
      if (!universeSymbols.has(sym)) {
        ineligibleCounts.NOT_IN_UNIVERSE += 1;
        continue;
      }
      if (!isFiniteNum(s.lastPrice) || s.lastPrice <= 0) {
        ineligibleCounts.MISSING_LASTPRICE += 1;
        continue;
      }
      if (!isFiniteNum(s.turnover24h)) {
        ineligibleCounts.MISSING_TURNOVER += 1;
        continue;
      }
      const volPct = getVolPctFromTicker(s);
      if (!isFiniteNum(volPct)) {
        ineligibleCounts.MISSING_VOL_FIELDS += 1;
        continue;
      }
      if (s.turnover24h < turnoverMin) {
        ineligibleCounts.BELOW_TURNOVER_MIN += 1;
        continue;
      }
      if (volPct < volMin) {
        ineligibleCounts.BELOW_VOL_MIN += 1;
        continue;
      }
      rows.push({ symbol: sym, turnover24h: s.turnover24h });
    }
    rows.sort((a, b) => {
      if (b.turnover24h !== a.turnover24h) return b.turnover24h - a.turnover24h;
      return a.symbol.localeCompare(b.symbol);
    });
    const eligible = rows.slice(0, limit).map((r) => r.symbol);
    lastEligibility = { eligibleCount: eligible.length, ineligibleCounts };
    return eligible;
  }

  async function sendTopicOps(op, topics = []) {
    for (const c of chunk(topics, 100)) {
      ws.send(JSON.stringify({ op, args: c }));
      await new Promise((r) => setTimeout(r, 75));
    }
  }

  function inBootstrapGrace() {
    return bootstrapStartedAtMs > 0 && (Date.now() - bootstrapStartedAtMs) < bootstrapGraceMs;
  }

  function parseSymbolFromTopic(topic = '') {
    const parts = String(topic).split('.');
    return parts[parts.length - 1] || '';
  }

  async function reconcileSubscriptions(reason = 'periodic') {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    const desiredSymbols = getEligibleSymbols({
      turnoverMin: selectionPolicy.turnover24hMin,
      volMin: selectionPolicy.vol24hMin,
      cap: selectionPolicy.cap,
    });
    const desiredTickerTopics = new Set(desiredSymbols.map((s) => `tickers.${s}`));
    const desiredKlineTopics = new Set();
    for (const symbol of desiredSymbols) {
      for (const interval of activeIntervals) desiredKlineTopics.add(`kline.${interval}.${symbol}`);
    }

    const toSubTickers = [...desiredTickerTopics].filter((t) => !subscribedTickers.has(t));
    const desiredFloor = Math.max(0, selectionPolicy.cap - 5);
    const protectUnsub = inBootstrapGrace();
    const toUnTickers = [...subscribedTickers].filter((t) => {
      if (desiredTickerTopics.has(t)) return false;
      const sym = parseSymbolFromTopic(t);
      if (!universeSymbols.has(sym)) return true;
      if (protectUnsub && subscribedTickers.size <= Math.ceil(selectionPolicy.cap * 1.2)) return false;
      if ((now - Number(subscribedAtMs.get(t) || 0)) < minHoldSubscribedMs) return false;
      return true;
    });
    await sendTopicOps('subscribe', toSubTickers);
    toSubTickers.forEach((t) => {
      subscribedTickers.add(t);
      subscribedAtMs.set(t, now);
    });
    await sendTopicOps('unsubscribe', toUnTickers);
    toUnTickers.forEach((t) => {
      subscribedTickers.delete(t);
      subscribedAtMs.delete(t);
    });

    if (!inBootstrapGrace() && desiredSymbols.length >= selectionPolicy.cap && subscribedTickers.size < desiredFloor) {
      const floorAdds = [...desiredTickerTopics].filter((t) => !subscribedTickers.has(t)).slice(0, desiredFloor - subscribedTickers.size);
      await sendTopicOps('subscribe', floorAdds);
      floorAdds.forEach((t) => {
        subscribedTickers.add(t);
        subscribedAtMs.set(t, now);
      });
    }

    const toSubKlines = [...desiredKlineTopics].filter((t) => !subscribedKlines.has(t));
    const toUnKlines = [...subscribedKlines].filter((t) => {
      if (desiredKlineTopics.has(t)) return false;
      if (protectUnsub) return false;
      return true;
    });
    await sendTopicOps('subscribe', toSubKlines);
    toSubKlines.forEach((t) => subscribedKlines.add(t));
    await sendTopicOps('unsubscribe', toUnKlines);
    toUnKlines.forEach((t) => subscribedKlines.delete(t));

    logger.debug?.({ reason, desiredCount: desiredSymbols.length, subscribedTickers: subscribedTickers.size, bootstrapGrace: inBootstrapGrace() }, 'momentum reconcile complete');
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
    reconcileSubscriptions('activeIntervals').catch((e) => logger.warn?.({ err: e }, 'momentum active intervals reconcile failed'));
  }

  function setSelectionPolicy({ cap: nextCap, turnover24hMin: nextTurnoverMin, vol24hMin: nextVolMin } = {}) {
    const parsedCap = Math.trunc(Number(nextCap));
    if (Number.isFinite(parsedCap)) selectionPolicy.cap = Math.max(MIN_SELECTION_CAP, Math.min(MAX_SELECTION_CAP, parsedCap));
    const parsedTurnover = Number(nextTurnoverMin);
    if (Number.isFinite(parsedTurnover)) selectionPolicy.turnover24hMin = Math.max(0, parsedTurnover);
    const parsedVol = Number(nextVolMin);
    if (Number.isFinite(parsedVol)) selectionPolicy.vol24hMin = Math.max(0, parsedVol);
    reconcileSubscriptions('selectionPolicy').catch((e) => logger.warn?.({ err: e }, 'momentum selection policy reconcile failed'));
  }

  function getOiAgeSec(symbol) {
    const ts = oiLastUpdateTsMs.get(symbol);
    if (!(ts > 0)) return Number.POSITIVE_INFINITY;
    return Math.max(0, (Date.now() - ts) / 1000);
  }

  function getOiValue(symbol) {
    return Number(current.get(symbol)?.oiValue || 0);
  }

  function isDataFresh(maxAgeMs = 5000) {
    return connected && (Date.now() - Number(lastTickTs || 0)) <= maxAgeMs;
  }

  async function start() {
    if (started) return;
    started = true;
    bootstrapStartedAtMs = Date.now();
    await fetchUniverse();
    try {
      await refreshTickersSnapshot();
    } catch (err) {
      logger.warn?.({ err }, 'momentum tickers bootstrap failed');
    }
    connect();
    reconcileSubscriptions('startup').catch((e) => logger.warn?.({ err: e }, 'momentum initial reconcile failed'));
    setInterval(() => onTick(Date.now()), 1000);
    setInterval(() => { fetchUniverse().catch((e) => logger.warn?.({ err: e }, 'momentum universe refresh failed')); }, 15 * 60 * 1000);
    setInterval(() => { reconcileSubscriptions('periodic').catch((e) => logger.warn?.({ err: e }, 'momentum sub reconcile failed')); }, 45 * 1000);
    setInterval(() => { refreshTickersSnapshot().catch((e) => logger.warn?.({ err: e }, 'momentum tickers snapshot refresh failed')); }, 45 * 1000);
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
    isDataFresh,
    getEligibleSymbols,
    getTurnoverGate,
    setActiveIntervals,
    setSelectionPolicy,
    reconcileSubscriptions,
    getStatus: () => ({
      wsConnected: connected,
      subscribedCount: subscribedTickers.size,
      eligibleCount: getEligibleSymbols().length,
      ineligibleCounts: { ...lastEligibility.ineligibleCounts },
      universeCount: instruments.size,
      cap: selectionPolicy.cap,
      selectionCap: selectionPolicy.cap,
      selectionTurnoverMin: selectionPolicy.turnover24hMin,
      selectionVolMin: selectionPolicy.vol24hMin,
      desiredCap: selectionPolicy.cap,
      turnoverMin: selectionPolicy.turnover24hMin,
      volMin: selectionPolicy.vol24hMin,
      lastTickTs,
      tickDriftMs,
      tickersSnapshotTsMs,
      tickersSnapshotCount,
      tickersSnapshotMissingFieldsCount,
      snapshotAgeSec: tickersSnapshotTsMs > 0 ? Math.max(0, Math.floor((Date.now() - tickersSnapshotTsMs) / 1000)) : null,
      bootstrapAgeSec: bootstrapStartedAtMs > 0 ? Math.max(0, Math.floor((Date.now() - bootstrapStartedAtMs) / 1000)) : 0,
      inBootstrapGrace: inBootstrapGrace(),
      activeIntervals: [...activeIntervals].sort((a, b) => a - b),
      klineSubscribedCount: subscribedKlines.size,
    }),
  };
}

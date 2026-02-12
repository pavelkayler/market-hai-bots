// backend/src/microBars.js
import { RingBuffer } from "./ringBuffer.js";

function pickPrice(t) {
  if (Number.isFinite(t?.mid)) return t.mid;
  if (Number.isFinite(t?.bid) && Number.isFinite(t?.ask)) return (t.bid + t.ask) / 2;
  if (Number.isFinite(t?.last)) return t.last;
  if (Number.isFinite(t?.mark)) return t.mark;
  return null;
}

function normalizeSource(source) {
  const src = String(source || "").toUpperCase();
  if (src === "BT" || src === "BYBIT") return "BT";
  if (src === "BNB" || src === "BINANCE") return "BNB";
  return null;
}

export function createMicroBarAggregator({
  bucketMs = 250,
  keepMs = 120000,
  onBar = () => {},
} = {}) {
  const capacity = Math.max(10, Math.ceil(keepMs / bucketMs) + 10);
  const perKey = new Map(); // `${source}:${symbol}` -> { rb, cur, lastClose, symbol, source }

  function keyOf(symbol, source) {
    return `${source}:${symbol}`;
  }

  function ensure(symbol, source) {
    const key = keyOf(symbol, source);
    let st = perKey.get(key);
    if (!st) {
      st = { rb: new RingBuffer(capacity), cur: null, lastClose: null, symbol, source };
      perKey.set(key, st);
    }
    return st;
  }

  function finalize(st) {
    if (!st.cur) return;
    const bar = { symbol: st.symbol, source: st.source, ...st.cur };
    st.rb.push(bar);
    st.lastClose = st.cur.c;
    onBar(bar);
    st.cur = null;
  }

  function makeSynthetic(st, ts, px) {
    return { symbol: st.symbol, source: st.source, ts, o: px, h: px, l: px, c: px, v: 0, synthetic: true };
  }

  function ingest(ticker) {
    const symbol = String(ticker?.symbol || "").toUpperCase();
    const source = normalizeSource(ticker?.source || ticker?.src);
    if (!symbol || !source) return;

    const px = pickPrice(ticker);
    if (!Number.isFinite(px)) return;

    const st = ensure(symbol, source);

    const rawTs = Number(ticker?.ts ?? ticker?.receivedAt ?? Date.now());
    const ts = Number.isFinite(rawTs) ? rawTs : Date.now();
    const bucketTs = Math.floor(ts / bucketMs) * bucketMs;

    if (!st.cur) {
      st.cur = { ts: bucketTs, o: px, h: px, l: px, c: px, v: 1 };
      return;
    }

    if (bucketTs === st.cur.ts) {
      st.cur.h = Math.max(st.cur.h, px);
      st.cur.l = Math.min(st.cur.l, px);
      st.cur.c = px;
      st.cur.v += 1;
      return;
    }

    const prevTs = st.cur.ts;
    finalize(st);

    const gap = bucketTs - prevTs;
    if (gap > bucketMs && Number.isFinite(st.lastClose)) {
      for (let t = prevTs + bucketMs; t < bucketTs; t += bucketMs) {
        const sbar = makeSynthetic(st, t, st.lastClose);
        st.rb.push(sbar);
        onBar(sbar);
      }
    }

    st.cur = { ts: bucketTs, o: px, h: px, l: px, c: px, v: 1 };
  }

  function getBars(symbol, n = 500, source = "BT") {
    const sym = String(symbol || "").trim().toUpperCase();
    const src = normalizeSource(source);
    if (!sym || !src) return [];
    const st = perKey.get(keyOf(sym, src));
    if (!st) return [];
    return st.rb.last(n);
  }

  return { ingest, getBars };
}

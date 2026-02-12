// backend/src/microBars.js
import { RingBuffer } from "./ringBuffer.js";

function pickPrice(t) {
  // mid -> last -> mark
  if (Number.isFinite(t?.bid) && Number.isFinite(t?.ask)) return (t.bid + t.ask) / 2;
  if (Number.isFinite(t?.last)) return t.last;
  if (Number.isFinite(t?.mark)) return t.mark;
  return null;
}

export function createMicroBarAggregator({
  bucketMs = 250,
  keepMs = 120000, // 60–120s
  onBar = () => {},
} = {}) {
  const capacity = Math.max(10, Math.ceil(keepMs / bucketMs) + 10);
  const perSymbol = new Map(); // symbol -> { rb, cur, lastClose }

  function ensure(sym) {
    let st = perSymbol.get(sym);
    if (!st) {
      st = {
        rb: new RingBuffer(capacity),
        cur: null, // { t,o,h,l,c,nTicks }
        lastClose: null,
      };
      perSymbol.set(sym, st);
    }
    return st;
  }

  function finalize(sym, st) {
    if (!st.cur) return;
    const bar = { symbol: sym, ...st.cur };
    st.rb.push(bar);
    st.lastClose = st.cur.c;
    onBar(bar);
    st.cur = null;
  }

  function makeSynthetic(sym, t, px) {
    return { symbol: sym, t, o: px, h: px, l: px, c: px, nTicks: 0, synthetic: true };
  }

  function ingest(ticker) {
    const sym = ticker?.symbol;
    if (!sym) return;

    const px = pickPrice(ticker);
    if (!Number.isFinite(px)) return;

    const st = ensure(sym);

    const ts = Number.isFinite(ticker?.receivedAt) ? ticker.receivedAt : Date.now();
    const bucketT = Math.floor(ts / bucketMs) * bucketMs;

    // first
    if (!st.cur) {
      st.cur = { t: bucketT, o: px, h: px, l: px, c: px, nTicks: 1 };
      return;
    }

    // same bucket
    if (bucketT === st.cur.t) {
      st.cur.h = Math.max(st.cur.h, px);
      st.cur.l = Math.min(st.cur.l, px);
      st.cur.c = px;
      st.cur.nTicks++;
      return;
    }

    // bucket advanced: finalize previous
    const prevT = st.cur.t;
    finalize(sym, st);

    // gap-fill (если перескочили через несколько бакетов)
    const gap = bucketT - prevT;
    if (gap > bucketMs && Number.isFinite(st.lastClose)) {
      for (let t = prevT + bucketMs; t < bucketT; t += bucketMs) {
        const sbar = makeSynthetic(sym, t, st.lastClose);
        st.rb.push(sbar);
        onBar(sbar);
      }
    }

    // start new bucket
    st.cur = { t: bucketT, o: px, h: px, l: px, c: px, nTicks: 1 };
  }

  function getBars(symbol, n = 500) {
    const sym = String(symbol || "").trim().toUpperCase();
    const st = perSymbol.get(sym);
    if (!st) return [];
    // текущий незакрытый бар не выдаём (чтобы не “прыгал”)
    return st.rb.last(n);
  }

  function getLatestBar(symbol) {
    const bars = getBars(symbol, 1);
    return bars[0] || null;
  }

  return { ingest, getBars, getLatestBar };
}

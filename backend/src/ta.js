// backend/src/ta.js
// Minimal TA helpers for the pullback strategy.

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  let sum = 0;
  let count = 0;

  // true range uses previous close
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    if (Number.isFinite(tr)) {
      sum += tr;
      count++;
    }
  }

  if (count < period) return null;

  // simple moving average of TR over last 'period' entries
  // we already summed all; compute tail only for stability
  let tail = 0;
  let tailCount = 0;
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    if (Number.isFinite(tr)) {
      tail += tr;
      tailCount++;
    }
  }

  return tailCount ? tail / tailCount : null;
}

export function pivots(candles, left = 2, right = 2) {
  // returns arrays of pivot highs/lows: { t, price, idx }
  const highs = [];
  const lows = [];
  if (!Array.isArray(candles)) return { highs, lows };

  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].h >= h) isHigh = false;
      if (candles[j].l <= l) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) highs.push({ t: candles[i].t, price: h, idx: i });
    if (isLow) lows.push({ t: candles[i].t, price: l, idx: i });
  }

  return { highs, lows };
}

export function lastClosedCandle(candles) {
  // Bybit returns closed candles; but we treat the last element as "latest closed".
  if (!Array.isArray(candles) || candles.length === 0) return null;
  return candles[candles.length - 1];
}

export function trendFromSwings(pivotHighs, pivotLows) {
  // Simple HH/HL vs LH/LL heuristic.
  const hs = Array.isArray(pivotHighs) ? pivotHighs : [];
  const ls = Array.isArray(pivotLows) ? pivotLows : [];
  if (hs.length < 2 || ls.length < 2) return "range";

  const h1 = hs[hs.length - 1].price;
  const h0 = hs[hs.length - 2].price;
  const l1 = ls[ls.length - 1].price;
  const l0 = ls[ls.length - 2].price;

  if (h1 > h0 && l1 > l0) return "up";
  if (h1 < h0 && l1 < l0) return "down";
  return "range";
}

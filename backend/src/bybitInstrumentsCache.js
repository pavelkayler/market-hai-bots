// backend/src/bybitInstrumentsCache.js

import { createBybitRest } from "./bybitRest.js";

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function isPerpInstrument(it) {
  const sym = String(it?.symbol || "");
  if (!sym || sym.includes("-")) return false;
  const ct = String(it?.contractType || it?.contract_type || "").toLowerCase();
  if (ct && !ct.includes("perpetual")) return false;
  return true;
}

export function createBybitInstrumentsCache({ baseUrl, privateRest = null, logger = console, ttlMs = 30 * 60 * 1000 } = {}) {
  const publicRest = createBybitRest({ baseUrl, logger });
  let cachedAt = 0;
  let map = new Map();

  async function fetchAllLinear() {
    if (privateRest?.enabled && privateRest.getInstrumentsInfo) {
      const res = await privateRest.getInstrumentsInfo({ category: "linear", limit: 1000 });
      return res?.result?.list || [];
    }
    return publicRest.getInstrumentsLinearAll();
  }

  async function refresh() {
    const list = await fetchAllLinear();
    const next = new Map();

    for (const it of list) {
      if (!isPerpInstrument(it)) continue;
      const sym = String(it.symbol || "").toUpperCase();
      const tickSize = num(it?.priceFilter?.tickSize);
      const qtyStep = num(it?.lotSizeFilter?.qtyStep);
      const minQty = num(it?.lotSizeFilter?.minOrderQty);

      next.set(sym, {
        symbol: sym,
        tickSize: tickSize || null,
        qtyStep: qtyStep || null,
        minQty: minQty || null,
      });
    }

    map = next;
    cachedAt = Date.now();
    return { ok: true, count: map.size, cachedAt };
  }

  async function ensure() {
    if (map.size && Date.now() - cachedAt < ttlMs) return;
    await refresh();
  }

  async function get(symbol) {
    await ensure();
    return map.get(String(symbol || "").toUpperCase()) || null;
  }

  return {
    refresh,
    get,
    getStatus: () => ({ cachedAt: cachedAt || null, count: map.size, ageMs: cachedAt ? Date.now() - cachedAt : null }),
  };
}

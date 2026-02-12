// backend/src/bybitInstrumentsCache.js
// Fetch & cache instrument filters for Bybit linear perpetual contracts.

import { createBybitRest } from "./bybitRest.js";

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function isPerpInstrument(it) {
  const sym = String(it?.symbol || "");
  if (!sym) return false;
  // Dated futures look like DOGEUSDT-13FEB26
  if (sym.includes("-")) return false;
  // Prefer explicit contractType if present
  const ct = String(it?.contractType || it?.contract_type || "").toLowerCase();
  if (ct && !ct.includes("perpetual")) return false;
  return true;
}

export function createBybitInstrumentsCache({ baseUrl, logger = console, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
  const rest = createBybitRest({ baseUrl, logger });

  let cachedAt = 0;
  let map = new Map(); // symbol -> filters

  async function refresh() {
    const list = await rest.getInstrumentsLinearAll();
    const next = new Map();

    for (const it of list) {
      if (!isPerpInstrument(it)) continue;
      const sym = String(it.symbol || "").toUpperCase();

      const tickSize = num(it?.priceFilter?.tickSize ?? it?.priceFilter?.tick_size);
      const qtyStep = num(it?.lotSizeFilter?.qtyStep ?? it?.lotSizeFilter?.qty_step);
      const minQty = num(it?.lotSizeFilter?.minOrderQty ?? it?.lotSizeFilter?.min_order_qty);
      const minNotional = num(it?.lotSizeFilter?.minNotionalValue ?? it?.lotSizeFilter?.min_notional_value);

      next.set(sym, {
        symbol: sym,
        tickSize: tickSize || null,
        qtyStep: qtyStep || null,
        minQty: minQty || null,
        minNotional: minNotional || null,
      });
    }

    map = next;
    cachedAt = Date.now();
    return { ok: true, count: map.size, cachedAt };
  }

  async function ensure() {
    const age = Date.now() - cachedAt;
    if (map.size && age < ttlMs) return;
    await refresh();
  }

  async function get(symbol) {
    await ensure();
    return map.get(String(symbol || "").toUpperCase()) || null;
  }

  async function getAll() {
    await ensure();
    return Array.from(map.values());
  }

  function getStatus() {
    return {
      cachedAt: cachedAt || null,
      ageMs: cachedAt ? Date.now() - cachedAt : null,
      count: map.size,
    };
  }

  return {
    refresh,
    get,
    getAll,
    getStatus,
  };
}

// backend/src/bybitTradeExecutor.js
// Demo/real execution via Bybit V5 private REST.
// Entry: market. TP: reduceOnly limit orders. SL: /v5/position/trading-stop (Full, Market).

function num(x){const n=Number(x);return Number.isFinite(n)?n:null;}

function roundToStep(v, step, mode="floor") {
  const n = num(v);
  const s = num(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  const k = n / s;
  const kk = mode === "ceil" ? Math.ceil(k) : mode === "nearest" ? Math.round(k) : Math.floor(k);
  return kk * s;
}

export function createBybitTradeExecutor({ privateRest, instruments, logger = console } = {}) {
  function enabled() {
    return Boolean(privateRest && privateRest.enabled);
  }

  function getStatus() {
    return privateRest?.getStatus ? privateRest.getStatus() : { enabled: false };
  }

  async function normalizeQtyPrice(symbol, qty, price) {
    const f = instruments ? await instruments.get(symbol) : null;
    const qtyStep = f?.qtyStep;
    const tickSize = f?.tickSize;
    const minQty = f?.minQty;

    let q = num(qty);
    let p = num(price);

    if (Number.isFinite(qtyStep) && qtyStep > 0) q = roundToStep(q, qtyStep, "floor");
    if (Number.isFinite(minQty) && minQty > 0 && q < minQty) q = minQty;
    if (Number.isFinite(tickSize) && tickSize > 0 && Number.isFinite(p)) p = roundToStep(p, tickSize, "nearest");

    return { qty: q, price: p, filters: f };
  }

  async function placeMarket({ symbol, side, qty, reduceOnly = false, positionIdx = 0 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q } = await normalizeQtyPrice(symbol, qty, null);
    if (!Number.isFinite(q) || q <= 0) throw new Error("bad_qty");

    return privateRest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(q),
      timeInForce: "IOC",
      reduceOnly: Boolean(reduceOnly),
      positionIdx: Number(positionIdx) || 0,
    });
  }

  async function placeReduceLimit({ symbol, side, qty, price, positionIdx = 0 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, price: p } = await normalizeQtyPrice(symbol, qty, price);
    if (!Number.isFinite(q) || q <= 0) throw new Error("bad_qty");
    if (!Number.isFinite(p) || p <= 0) throw new Error("bad_price");

    return privateRest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Limit",
      qty: String(q),
      price: String(p),
      timeInForce: "GTC",
      reduceOnly: true,
      positionIdx: Number(positionIdx) || 0,
    });
  }

  async function setTradingStop({ symbol, side, slPrice, positionIdx = 0, triggerBy = "LastPrice" } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { price: sl } = await normalizeQtyPrice(symbol, 1, slPrice);
    if (!Number.isFinite(sl) || sl <= 0) throw new Error("bad_sl");

    return privateRest.setTradingStop({
      category: "linear",
      symbol,
      tpslMode: "Full",
      slTriggerBy: triggerBy,
      slOrderType: "Market",
      slSize: "0", // ignored in Full mode
      slTriggerPrice: String(sl),
      positionIdx: Number(positionIdx) || 0,
    });
  }

  async function cancelAll({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    return privateRest.cancelAll({ category: "linear", symbol });
  }

  async function getPosition({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getPositions({ category: "linear", symbol });
    const list = res?.result?.list || [];
    return list[0] || null;
  }

  async function getOpenOrders({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getOrdersRealtime({ category: "linear", symbol, openOnly: 0 });
    return res?.result?.list || [];
  }

  async function getClosedPnl({ symbol, limit = 20 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getClosedPnl({ category: "linear", symbol, limit: String(limit) });
    return res?.result?.list || [];
  }

  async function openPosition({ symbol, side, qty, sl, tps, positionIdx = 0 } = {}) {
    // side: Buy|Sell
    // tps: array of { price, weight }
    if (!enabled()) throw new Error("trade_disabled");
    const entry = await placeMarket({ symbol, side, qty, reduceOnly: false, positionIdx });

    // SL first (so we are protected quickly)
    if (Number.isFinite(num(sl))) {
      await setTradingStop({ symbol, side, slPrice: sl, positionIdx });
    }

    // TP reduce-only limit orders
    if (Array.isArray(tps)) {
      for (const tp of tps) {
        const tpPrice = num(tp?.price);
        const w = num(tp?.weight);
        if (!Number.isFinite(tpPrice) || !Number.isFinite(w) || w <= 0) continue;
        const legQty = qty * w;
        // opposite side to close
        const closeSide = side === "Buy" ? "Sell" : "Buy";
        await placeReduceLimit({ symbol, side: closeSide, qty: legQty, price: tpPrice, positionIdx });
      }
    }

    return entry;
  }

  return {
    enabled,
    getStatus,
    normalizeQtyPrice,
    placeMarket,
    placeReduceLimit,
    setTradingStop,
    cancelAll,
    getPosition,
    getOpenOrders,
    getClosedPnl,
    openPosition,
  };
}

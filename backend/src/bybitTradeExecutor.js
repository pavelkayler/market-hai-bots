// backend/src/bybitTradeExecutor.js
// Demo/real execution via Bybit V5 private REST.
// Entry: market. TP: reduceOnly limit orders. SL: /v5/position/trading-stop (Full, Market).

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function roundToStep(v, step, mode = "floor") {
  const n = num(v);
  const s = num(step);
  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) return n;
  const k = n / s;
  const kk = mode === "ceil" ? Math.ceil(k) : mode === "nearest" ? Math.round(k) : Math.floor(k);
  return kk * s;
}

function sumNums(arr) {
  return arr.reduce((acc, x) => acc + (num(x) || 0), 0);
}

export function createBybitTradeExecutor({ privateRest, instruments, logger = console } = {}) {
  function enabled() {
    return Boolean(privateRest && privateRest.enabled);
  }

  function getStatus() {
    return privateRest?.getStatus ? privateRest.getStatus() : { enabled: false };
  }

  async function normalizeQtyPrice(symbol, qty, price, { qtyMode = "floor", priceMode = "nearest" } = {}) {
    const f = instruments ? await instruments.get(symbol) : null;
    const qtyStep = f?.qtyStep;
    const tickSize = f?.tickSize;

    let q = num(qty);
    let p = num(price);

    if (Number.isFinite(qtyStep) && qtyStep > 0) q = roundToStep(q, qtyStep, qtyMode);
    if (Number.isFinite(tickSize) && tickSize > 0 && Number.isFinite(p)) p = roundToStep(p, tickSize, priceMode);

    return { qty: q, price: p, filters: f };
  }

  async function placeReduceLimit({ symbol, side, qty, price, timeInForce = "GTC", positionIdx = 0, priceMode = "nearest" } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, price: p } = await normalizeQtyPrice(symbol, qty, price, { qtyMode: "floor", priceMode });
    if (!Number.isFinite(q) || q <= 0) throw new Error("bad_qty");
    if (!Number.isFinite(p) || p <= 0) throw new Error("bad_price");

    return privateRest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Limit",
      qty: String(q),
      price: String(p),
      timeInForce,
      reduceOnly: true,
      positionIdx,
    });
  }

  async function openPosition({ symbol, side, qty, slPrice, tps = [], leverage, timeInForce = "GTC", positionIdx = 0 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, filters } = await normalizeQtyPrice(symbol, qty, null);
    if (!Number.isFinite(q) || q <= 0) {
      logger?.warn?.({ symbol, qty }, "entry qty is zero/invalid after rounding");
      throw new Error("bad_qty");
    }

    if (privateRest.switchIsolated) {
      try {
        await privateRest.switchIsolated({ category: "linear", symbol, tradeMode: 1, buyLeverage: "1", sellLeverage: "1" });
      } catch (e) {
        logger?.warn?.({ err: e, symbol }, "switch isolated failed, continuing");
      }
    }

    if (Number.isFinite(num(leverage)) && privateRest.setLeverage) {
      try {
        await privateRest.setLeverage({
          category: "linear",
          symbol,
          buyLeverage: String(leverage),
          sellLeverage: String(leverage),
        });
      } catch (e) {
        logger?.warn?.({ err: e, symbol, leverage }, "set leverage failed, continuing");
      }
    }

    const entryRes = await privateRest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: String(q),
      timeInForce: "IOC",
      reduceOnly: false,
      positionIdx,
    });

    let slSet = false;
    let slRounded = null;
    if (Number.isFinite(num(slPrice))) {
      const slMode = side === "Buy" ? "floor" : "ceil";
      const { price: sl } = await normalizeQtyPrice(symbol, 1, slPrice, { priceMode: slMode });
      if (Number.isFinite(sl) && sl > 0) {
        slRounded = sl;
        logger?.info?.({ symbol, slRaw: slPrice, slRounded: sl }, "SL rounded");
        await privateRest.setTradingStop({
          category: "linear",
          symbol,
          tpslMode: "Full",
          slOrderType: "Market",
          slTriggerBy: "MarkPrice",
          sl: String(sl),
          positionIdx,
        });
        slSet = true;
      }
    }

    const tpOrderIds = [];
    const closeSide = side === "Buy" ? "Sell" : "Buy";
    const tpRows = Array.isArray(tps) ? tps.slice(0, 3) : [];
    const step = filters?.qtyStep;

    const firstLegs = [q * 0.4, q * 0.3].map((x) => (Number.isFinite(step) && step > 0 ? roundToStep(x, step, "floor") : x));
    const remQtyRaw = q - sumNums(firstLegs);
    const tpQtys = [firstLegs[0], firstLegs[1], Number.isFinite(step) && step > 0 ? roundToStep(remQtyRaw, step, "floor") : remQtyRaw];

    for (let i = 0; i < tpRows.length; i += 1) {
      const tp = tpRows[i];
      const tpQtyRaw = num(tpQtys[i]);
      const tpPriceRaw = num(tp?.price);
      if (!Number.isFinite(tpQtyRaw) || tpQtyRaw <= 0 || !Number.isFinite(tpPriceRaw) || tpPriceRaw <= 0) continue;
      const tpPriceMode = side === "Buy" ? "ceil" : "floor";
      logger?.info?.({ symbol, tpQtyRaw, tpPriceRaw }, "TP raw");
      const res = await placeReduceLimit({ symbol, side: closeSide, qty: tpQtyRaw, price: tpPriceRaw, timeInForce, positionIdx, priceMode: tpPriceMode });
      const orderId = res?.result?.orderId || null;
      if (orderId) tpOrderIds.push(orderId);
    }

    return {
      entryOrderId: entryRes?.result?.orderId || null,
      tpOrderIds,
      slSet,
      slRounded,
    };
  }

  async function sync({ symbol, closedPnlLimit = 20 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const [positionRes, ordersRes, pnlRes] = await Promise.all([
      privateRest.getPositions({ category: "linear", symbol }),
      privateRest.getOrdersRealtime({ category: "linear", symbol }),
      privateRest.getClosedPnl({ category: "linear", symbol, limit: String(closedPnlLimit) }),
    ]);

    return {
      position: (positionRes?.result?.list || [])[0] || null,
      openOrders: ordersRes?.result?.list || [],
      closedPnL: pnlRes?.result?.list || [],
    };
  }

  async function getPosition({ symbol } = {}) {
    const list = await getPositions({ symbol });
    return list[0] || null;
  }

  async function getPositions({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getPositions({ category: "linear", symbol });
    return res?.result?.list || [];
  }

  async function getOpenOrders({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getOrdersRealtime({ category: "linear", symbol });
    return res?.result?.list || [];
  }

  async function getClosedPnl({ symbol, limit = 20 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getClosedPnl({ category: "linear", symbol, limit: String(limit) });
    return res?.result?.list || [];
  }

  async function cancelAll({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.cancelAll({ category: "linear", symbol });
    return { ok: true, result: res?.result || null };
  }

  return {
    enabled,
    getStatus,
    normalizeQtyPrice,
    openPosition,
    sync,
    getPosition,
    getPositions,
    getOpenOrders,
    getClosedPnl,
    cancelAll,
  };
}

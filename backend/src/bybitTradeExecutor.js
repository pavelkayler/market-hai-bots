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

function normalizePosition(row) {
  return {
    symbol: row?.symbol || "",
    side: row?.side || "",
    size: row?.size || "0",
    avgPrice: row?.avgPrice || null,
    liqPrice: row?.liqPrice || null,
    unrealisedPnl: row?.unrealisedPnl || row?.unrealisedPnlValue || null,
    marginMode: row?.tradeMode === 1 ? "isolated" : "cross",
    positionIdx: Number(row?.positionIdx ?? 0),
  };
}

function normalizeOrder(row) {
  return {
    orderId: row?.orderId || "",
    symbol: row?.symbol || "",
    side: row?.side || "",
    price: row?.price || null,
    qty: row?.qty || null,
    leavesQty: row?.leavesQty || null,
    status: row?.orderStatus || row?.status || "",
    reduceOnly: Boolean(row?.reduceOnly),
    createdTime: row?.createdTime || null,
  };
}

export function createBybitTradeExecutor({ privateRest, instruments, logger = console } = {}) {
  const state = {
    executionMode: "paper",
    killSwitch: false,
    activeSymbol: null,
    maxNotional: Number(process.env.TRADE_MAX_NOTIONAL || 100),
    maxLeverage: Number(process.env.TRADE_MAX_LEVERAGE || 10),
    maxActivePositions: Number(process.env.TRADE_MAX_ACTIVE_POSITIONS || 1),
  };

  function enabled() {
    return Boolean(privateRest && privateRest.enabled);
  }

  function getStatus() {
    return privateRest?.getStatus ? privateRest.getStatus() : { enabled: false };
  }

  function setExecutionMode(mode) {
    state.executionMode = mode === "real" ? "real" : mode === "demo" ? "demo" : "paper";
  }

  function getExecutionMode() {
    return state.executionMode;
  }

  function setKillSwitch(enabledFlag) {
    state.killSwitch = Boolean(enabledFlag);
    return state.killSwitch;
  }

  function getKillSwitch() {
    return state.killSwitch;
  }

  function setActiveSymbol(symbol) {
    state.activeSymbol = symbol ? String(symbol).toUpperCase() : null;
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

  async function detectPositionMode(symbol) {
    const rows = await getPositions({ symbol });
    const idxSet = new Set(rows.map((r) => Number(r.positionIdx ?? 0)).filter(Number.isFinite));
    const hedge = idxSet.has(1) || idxSet.has(2);
    return hedge ? "HEDGE" : "ONE_WAY";
  }

  async function resolvePositionIdx({ symbol, side, explicitPositionIdx } = {}) {
    if (Number.isFinite(Number(explicitPositionIdx))) return Number(explicitPositionIdx);
    const mode = await detectPositionMode(symbol);
    if (mode === "ONE_WAY") return 0;
    if (side === "Buy") return 1;
    if (side === "Sell") return 2;
    return 0;
  }

  async function runPreTradeChecks({ symbol, side, qty, priceHint, reduceOnly = false } = {}) {
    const reasons = [];
    if (state.executionMode === "paper") return { ok: true, reasons };
    if (state.killSwitch && !reduceOnly) reasons.push("KILL_SWITCH_ENABLED");
    if (state.executionMode === "demo" || state.executionMode === "real") {
      const rows = await getPositions({});
      const active = rows.filter((r) => Number(r?.size || 0) > 0);
      if (active.length >= state.maxActivePositions && !active.some((r) => r.symbol === symbol)) reasons.push("MAX_ONE_POSITION_GLOBAL");
      const notional = Math.abs(Number(qty || 0) * Number(priceHint || 0));
      if (Number.isFinite(notional) && notional > state.maxNotional) reasons.push(`NOTIONAL_LIMIT_EXCEEDED:${notional.toFixed(2)}>${state.maxNotional}`);
      if (active.some((r) => Number(r?.tradeMode) !== 1)) reasons.push("ISOLATED_MARGIN_REQUIRED");
    }
    const ok = reasons.length === 0;
    logger?.info?.({ symbol, side, mode: state.executionMode, reasons, ok }, ok ? "PRE-TRADE CHECK PASSED" : "PRE-TRADE CHECK FAILED");
    return { ok, reasons };
  }

  async function placeReduceLimit({ symbol, side, qty, price, timeInForce = "GTC", positionIdx, priceMode = "nearest" } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, price: p } = await normalizeQtyPrice(symbol, qty, price, { qtyMode: "floor", priceMode });
    if (!Number.isFinite(q) || q <= 0) throw new Error("bad_qty");
    if (!Number.isFinite(p) || p <= 0) throw new Error("bad_price");
    const resolvedPositionIdx = await resolvePositionIdx({ symbol, side, explicitPositionIdx: positionIdx });

    return privateRest.placeOrder({
      category: "linear",
      symbol,
      side,
      orderType: "Limit",
      qty: String(q),
      price: String(p),
      timeInForce,
      reduceOnly: true,
      positionIdx: resolvedPositionIdx,
    });
  }

  async function openPosition({ symbol, side, qty, slPrice, tps = [], leverage, timeInForce = "GTC", positionIdx } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, filters } = await normalizeQtyPrice(symbol, qty, null);
    if (!Number.isFinite(q) || q <= 0) {
      logger?.warn?.({ symbol, qty }, "entry qty is zero/invalid after rounding");
      throw new Error("bad_qty");
    }
    const pre = await runPreTradeChecks({ symbol, side, qty: q, reduceOnly: false });
    if (!pre.ok) throw new Error(pre.reasons.join(";"));

    const resolvedPositionIdx = await resolvePositionIdx({ symbol, side, explicitPositionIdx: positionIdx });

    if (privateRest.switchIsolated) {
      try {
        await privateRest.switchIsolated({ category: "linear", symbol, tradeMode: 1, buyLeverage: "1", sellLeverage: "1" });
      } catch (e) {
        logger?.warn?.({ err: e, symbol }, "switch isolated failed, continuing");
      }
    }

    if (Number.isFinite(num(leverage)) && privateRest.setLeverage) {
      const safeLeverage = Math.max(1, Math.min(state.maxLeverage, Number(leverage)));
      if (safeLeverage !== Number(leverage)) logger?.warn?.({ leverageRaw: leverage, leverageRounded: safeLeverage }, "LEVERAGE_GUARDRAIL_APPLIED");
      try {
        await privateRest.setLeverage({
          category: "linear",
          symbol,
          buyLeverage: String(safeLeverage),
          sellLeverage: String(safeLeverage),
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
      positionIdx: resolvedPositionIdx,
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
          positionIdx: resolvedPositionIdx,
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
      const res = await placeReduceLimit({ symbol, side: closeSide, qty: tpQtyRaw, price: tpPriceRaw, timeInForce, positionIdx: resolvedPositionIdx, priceMode: tpPriceMode });
      const orderId = res?.result?.orderId || null;
      if (orderId) tpOrderIds.push(orderId);
    }

    return {
      entryOrderId: entryRes?.result?.orderId || null,
      tpOrderIds,
      slSet,
      slRounded,
      positionIdx: resolvedPositionIdx,
      positionMode: await detectPositionMode(symbol),
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
    return (res?.result?.list || []).map(normalizePosition);
  }

  async function getOpenOrders({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getOrdersRealtime({ category: "linear", symbol });
    return (res?.result?.list || []).map(normalizeOrder);
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

  async function createHedgeOrders({ symbol, qty, longPrice, shortPrice } = {}) {
    const ack = { ok: true, queued: true };
    Promise.resolve().then(async () => {
      const mode = await detectPositionMode(symbol);
      const tasks = [];
      if (Number(longPrice) > 0) tasks.push(placeReduceLimit({ symbol, side: "Buy", qty, price: longPrice, positionIdx: mode === "HEDGE" ? 1 : 0 }));
      if (Number(shortPrice) > 0) tasks.push(placeReduceLimit({ symbol, side: "Sell", qty, price: shortPrice, positionIdx: mode === "HEDGE" ? 2 : 0 }));
      await Promise.all(tasks);
    }).catch((e) => logger?.warn?.({ err: e }, "createHedgeOrders async failed"));
    return ack;
  }

  function setGuardrails({ maxNotional, maxLeverage, maxActivePositions } = {}) {
    if (Number.isFinite(Number(maxNotional))) state.maxNotional = Number(maxNotional);
    if (Number.isFinite(Number(maxLeverage))) state.maxLeverage = Number(maxLeverage);
    if (Number.isFinite(Number(maxActivePositions))) state.maxActivePositions = Number(maxActivePositions);
    return { maxNotional: state.maxNotional, maxLeverage: state.maxLeverage, maxActivePositions: state.maxActivePositions };
  }

  return {
    enabled,
    getStatus,
    setExecutionMode,
    getExecutionMode,
    setKillSwitch,
    getKillSwitch,
    setActiveSymbol,
    setGuardrails,
    normalizeQtyPrice,
    openPosition,
    sync,
    getPosition,
    getPositions,
    getOpenOrders,
    getClosedPnl,
    cancelAll,
    detectPositionMode,
    resolvePositionIdx,
    createHedgeOrders,
  };
}

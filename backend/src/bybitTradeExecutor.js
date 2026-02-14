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
  const normalizedMarginMode = String(row?.marginMode || '').toLowerCase();
  const tradeMode = Number(row?.tradeMode);
  return {
    symbol: row?.symbol || "",
    side: row?.side || "",
    size: row?.size || "0",
    avgPrice: row?.avgPrice || null,
    liqPrice: row?.liqPrice || null,
    unrealisedPnl: row?.unrealisedPnl || row?.unrealisedPnlValue || null,
    marginMode: normalizedMarginMode === 'isolated' ? 'isolated' : tradeMode === 1 ? "isolated" : "cross",
    positionIdx: Number(row?.positionIdx ?? 0),
    stopLoss: num(row?.stopLoss),
    takeProfit: num(row?.takeProfit),
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

function isMeaningfulPosition(row) {
  return Math.abs(Number(row?.size || 0)) > 0.0000001;
}

function isActiveOrder(row) {
  const status = String(row?.status || "");
  return status === "New" || status === "PartiallyFilled" || status === "Created";
}

export function createBybitTradeExecutor({ privateRest, instruments, logger = console } = {}) {
  const REAL_ACK = process.env.I_UNDERSTAND_REAL_RISK === "1";
  const tradeBaseUrl = String(process.env.BYBIT_TRADE_BASE_URL || "https://api-demo.bybit.com");
  const state = {
    executionMode: "demo",
    killSwitch: false,
    activeSymbol: null,
    maxNotional: Number(process.env.TRADE_MAX_NOTIONAL || 100),
    maxLeverage: Number(process.env.TRADE_MAX_LEVERAGE || 10),
    maxActivePositions: Number(process.env.TRADE_MAX_ACTIVE_POSITIONS || 10),
  };
  const preflight = {
    hedgeMode: "UNKNOWN",
    lastHedgeModeCheckTs: null,
    lastHedgeModeError: null,
    marginMode: "UNKNOWN",
    lastMarginModeCheckTs: null,
    lastMarginModeError: null,
  };
  const isolatedCache = new Map();
  const isolatedInFlight = new Map();
  const isolatedTtlMs = 60 * 1000;
  const hedgeModeTtlMs = 30 * 1000;
  let hedgeSnapshot = { mode: 'UNKNOWN', checkedAt: 0, source: 'bybit', error: null };
  let hedgeInFlight = null;

  async function getOrderById({ symbol, orderId } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    if (!symbol || !orderId) return null;
    const query = { category: "linear", symbol, orderId };
    const realtime = await privateRest.getOrdersRealtime(query);
    const rows = realtime?.result?.list || [];
    if (rows.length > 0) return rows[0];
    if (!privateRest.getOrderHistory) return null;
    const hist = await privateRest.getOrderHistory(query);
    return (hist?.result?.list || [])[0] || null;
  }

  async function getExecutionsByOrderId({ symbol, orderId, limit = 50 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    if (!symbol || !orderId || !privateRest.getExecutions) return [];
    const res = await privateRest.getExecutions({ category: "linear", symbol, orderId, limit: String(limit) });
    return res?.result?.list || [];
  }

  async function ensureIsolatedPreflight({ symbol } = {}) {
    if (state.executionMode === "demo" || state.executionMode === "paper") {
      preflight.lastMarginModeCheckTs = Date.now();
      preflight.marginMode = "DEMO_PAPER_ASSUME_ISOLATED";
      preflight.lastMarginModeError = null;
      return { ok: true, marginMode: preflight.marginMode, skipped: true, message: 'Margin: DEMO/PAPER (switch isolated via API not supported/needed)' };
    }
    try {
      const sym = String(symbol || "BTCUSDT").toUpperCase();
      await getPositionsRaw({ symbol: sym });
      preflight.marginMode = preflight.marginMode === 'ISOLATED' ? 'ISOLATED' : 'UNKNOWN';
      preflight.lastMarginModeCheckTs = Date.now();
      preflight.lastMarginModeError = null;
      return { ok: true, marginMode: preflight.marginMode, symbol: sym };
    } catch (err) {
      preflight.marginMode = "UNKNOWN";
      preflight.lastMarginModeCheckTs = Date.now();
      preflight.lastMarginModeError = String(err?.message || err || "unknown");
      return { ok: false, marginMode: "UNKNOWN", error: preflight.lastMarginModeError };
    }
  }

  function enabled() {
    return Boolean(privateRest && privateRest.enabled);
  }

  function getStatus() {
    return privateRest?.getStatus ? privateRest.getStatus() : { enabled: false };
  }

  function setExecutionMode(mode) {
    const next = mode === "real" ? "real" : mode === "demo" ? "demo" : "paper";
    if (next === "real" && (!REAL_ACK || process.env.TRADE_REAL_ENABLED !== "1")) {
      state.executionMode = "paper";
      return;
    }
    state.executionMode = next;
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

  function getActiveSymbol() {
    return state.activeSymbol;
  }

  function getGuardrails() {
    return {
      maxNotionalUsd: Number(state.maxNotional),
      maxLeverage: Number(state.maxLeverage),
      maxActivePositions: Number(state.maxActivePositions),
    };
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
    const rows = await getPositionsRaw({ symbol });
    const idxSet = new Set(rows.map((r) => Number(r.positionIdx ?? 0)).filter(Number.isFinite));
    if (idxSet.size === 0) return "UNKNOWN";
    const hedge = idxSet.has(1) || idxSet.has(2);
    return hedge ? "HEDGE" : "ONE_WAY";
  }

  async function resolvePositionIdx({ symbol, side, explicitPositionIdx } = {}) {
    if (Number.isFinite(Number(explicitPositionIdx))) return Number(explicitPositionIdx);
    const mode = await detectPositionMode(symbol);
    if (mode === "ONE_WAY") return 0;
    if (mode === "UNKNOWN") throw new Error("POSITION_MODE_UNKNOWN");
    if (side === "Buy") return 1;
    if (side === "Sell") return 2;
    return 0;
  }

  async function getPositionModeFromAccount() {
    if (!privateRest.getAccountInfo) return "UNKNOWN";
    const res = await privateRest.getAccountInfo({});
    const list = res?.result?.list || [];
    const unifiedMarginStatus = Number(list[0]?.unifiedMarginStatus);
    if (unifiedMarginStatus === 3 || unifiedMarginStatus === 4 || unifiedMarginStatus === 5 || unifiedMarginStatus === 6) return "HEDGE";
    return "UNKNOWN";
  }

  async function ensureHedgeMode({ symbol } = {}) {
    if (state.executionMode === "paper") return { ok: true, mode: "HEDGE", skipped: true };
    if (hedgeInFlight) return hedgeInFlight;
    hedgeInFlight = (async () => {
      try {
        let mode = await getHedgeModeSnapshot({ symbol, force: true }).then((x) => x.mode);
        if (mode !== "HEDGE" && privateRest.switchPositionMode) {
          await privateRest.switchPositionMode({ category: "linear", mode: 3, symbol: symbol || undefined, coin: "USDT" });
          await new Promise((r) => setTimeout(r, 150));
          mode = await getHedgeModeSnapshot({ symbol, force: true }).then((x) => x.mode);
        }
        preflight.lastHedgeModeCheckTs = Date.now();
        preflight.hedgeMode = mode;
        if (mode !== "HEDGE") {
          preflight.lastHedgeModeError = "HEDGE MODE REQUIRED: enable Hedge (dual-side) in Bybit account settings, then restart.";
          return { ok: false, mode, error: preflight.lastHedgeModeError };
        }
        preflight.lastHedgeModeError = null;
        return { ok: true, mode };
      } catch (err) {
        preflight.lastHedgeModeCheckTs = Date.now();
        preflight.hedgeMode = "UNKNOWN";
        preflight.lastHedgeModeError = String(err?.message || err || "unknown");
        return { ok: false, mode: "UNKNOWN", error: preflight.lastHedgeModeError };
      } finally {
        hedgeInFlight = null;
      }
    })();
    return hedgeInFlight;
  }

  async function getHedgeModeSnapshot({ symbol, force = false } = {}) {
    if (state.executionMode === 'paper') {
      preflight.lastHedgeModeCheckTs = Date.now();
      preflight.hedgeMode = 'UNKNOWN';
      preflight.lastHedgeModeError = null;
      return { mode: 'UNKNOWN', checkedAt: preflight.lastHedgeModeCheckTs, source: 'bybit', skipped: true };
    }
    const now = Date.now();
    if (!force && hedgeSnapshot.checkedAt > 0 && (now - hedgeSnapshot.checkedAt) <= hedgeModeTtlMs) {
      return { ...hedgeSnapshot };
    }
    let mode = 'UNKNOWN';
    let error = null;
    try {
      mode = await detectPositionMode(symbol);
      if (mode === 'UNKNOWN') mode = await getPositionModeFromAccount();
    } catch (err) {
      error = String(err?.message || err || 'unknown');
    }
    hedgeSnapshot = { mode, checkedAt: now, source: 'bybit', error };
    preflight.lastHedgeModeCheckTs = now;
    preflight.hedgeMode = mode;
    preflight.lastHedgeModeError = error;
    return { ...hedgeSnapshot };
  }

  async function ensureIsolated({ symbol } = {}) {
    if (state.executionMode === "demo" || state.executionMode === "paper") {
      preflight.marginMode = "DEMO_PAPER_ASSUME_ISOLATED";
      preflight.lastMarginModeCheckTs = Date.now();
      preflight.lastMarginModeError = null;
      return { ok: true, marginMode: preflight.marginMode, skipped: true, message: 'Margin: DEMO/PAPER (switch isolated via API not supported/needed)' };
    }
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return { ok: false, error: "SYMBOL_REQUIRED" };
    const now = Date.now();
    const cached = isolatedCache.get(sym);
    if (cached && now - cached.ts <= isolatedTtlMs && cached.ok) return { ok: true, marginMode: "ISOLATED", cached: true };
    if (isolatedInFlight.has(sym)) return isolatedInFlight.get(sym);
    const run = (async () => {
      try {
        const before = await getPositionsRaw({ symbol: sym });
        const allIsolatedBefore = before.length > 0 && before.every((r) => String(r?.marginMode || '').toLowerCase() === 'isolated');
        if (!allIsolatedBefore) {
          if (!privateRest.switchIsolated) throw new Error("switch_isolated_not_supported");
          await privateRest.switchIsolated({ category: "linear", symbol: sym, tradeMode: 1, buyLeverage: "1", sellLeverage: "1" });
        }
        const after = await getPositionsRaw({ symbol: sym });
        const allIsolatedAfter = after.length > 0 && after.every((r) => String(r?.marginMode || '').toLowerCase() === 'isolated');
        if (!allIsolatedAfter) throw new Error("ISOLATED_MARGIN_NOT_CONFIRMED");
        preflight.marginMode = "ISOLATED";
        preflight.lastMarginModeCheckTs = Date.now();
        preflight.lastMarginModeError = null;
        isolatedCache.set(sym, { ok: true, ts: Date.now() });
        return { ok: true, marginMode: "ISOLATED" };
      } catch (err) {
        preflight.marginMode = "UNKNOWN";
        preflight.lastMarginModeCheckTs = Date.now();
        preflight.lastMarginModeError = String(err?.message || err || "unknown");
        return { ok: false, error: preflight.lastMarginModeError };
      } finally {
        isolatedInFlight.delete(sym);
      }
    })();
    isolatedInFlight.set(sym, run);
    return run;
  }

  async function runPreTradeChecks({ symbol, side, qty, priceHint, reduceOnly = false } = {}) {
    const reasons = [];
    if (state.executionMode === "paper") return { ok: true, reasons };
    if (state.killSwitch && !reduceOnly) reasons.push("KILL_SWITCH_ENABLED");
    if (state.activeSymbol && symbol && String(symbol).toUpperCase() !== state.activeSymbol) reasons.push("ACTIVE_SYMBOL_MISMATCH");
    let activePositionsCount = null;
    let effectiveMaxActivePositions = null;
    if (state.executionMode === "demo" || state.executionMode === "real") {
      if (state.executionMode === "demo" && !/api-demo\.bybit\.com/i.test(tradeBaseUrl)) reasons.push("DEMO_BASE_URL_REQUIRED");
      if (state.executionMode === "real" && !/api\.bybit\.com/i.test(tradeBaseUrl)) reasons.push("REAL_BASE_URL_REQUIRED");
      const rows = await getPositions({});
      const active = rows.filter((r) => Number(r?.size || 0) > 0);
      const hardCap = 10;
      const effectiveMax = Math.min(Number(state.maxActivePositions || hardCap), hardCap);
      activePositionsCount = active.length;
      effectiveMaxActivePositions = effectiveMax;
      if (active.length >= effectiveMax && !active.some((r) => r.symbol === symbol)) reasons.push("MAX_ACTIVE_POSITIONS_GLOBAL");
      const pxHint = Number(priceHint);
      if (Number.isFinite(pxHint) && pxHint > 0) {
        const notional = Math.abs(Number(qty || 0) * pxHint);
        if (Number.isFinite(notional) && notional > state.maxNotional) reasons.push(`NOTIONAL_LIMIT_EXCEEDED:${notional.toFixed(2)}>${state.maxNotional}`);
      }
      if (active.some((r) => String(r?.marginMode || '').toLowerCase() !== 'isolated')) reasons.push("ISOLATED_MARGIN_REQUIRED");
    }
    const ok = reasons.length === 0;
    logger?.info?.({ symbol, side, mode: state.executionMode, reasons, ok, activePositionsCount, effectiveMaxActivePositions }, ok ? "PRE-TRADE CHECK PASSED" : "PRE-TRADE CHECK FAILED");
    return { ok, reasons };
  }

  async function placeReduceLimit({ symbol, side, qty, price, timeInForce = "GTC", positionIdx, priceMode = "nearest" } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, price: p } = await normalizeQtyPrice(symbol, qty, price, { qtyMode: "floor", priceMode });
    if (!Number.isFinite(q) || q <= 0) throw new Error("bad_qty");
    if (!Number.isFinite(p) || p <= 0) throw new Error("bad_price");
    const isolated = await ensureIsolated({ symbol });
    if (!isolated.ok) throw new Error(`ISOLATED_MARGIN_REQUIRED:${isolated.error || 'unknown'}`);
    const hedge = await ensureHedgeMode({ symbol });
    if (!hedge.ok) throw new Error(hedge.error || "HEDGE_MODE_REQUIRED");
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

  async function openPosition({ symbol, side, qty, slPrice, tps = [], leverage, timeInForce = "GTC", positionIdx, priceHint } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const { qty: q, filters } = await normalizeQtyPrice(symbol, qty, null);
    if (!Number.isFinite(q) || q <= 0) {
      logger?.warn?.({ symbol, qty }, "entry qty is zero/invalid after rounding");
      throw new Error("bad_qty");
    }
    const pre = await runPreTradeChecks({ symbol, side, qty: q, priceHint, reduceOnly: false });
    if (!pre.ok) throw new Error(pre.reasons.join(";"));

    const isolated = await ensureIsolated({ symbol });
    if (!isolated.ok) throw new Error(`ISOLATED_MARGIN_REQUIRED:${isolated.error || 'unknown'}`);
    const hedge = await ensureHedgeMode({ symbol });
    if (!hedge.ok) throw new Error(hedge.error || "HEDGE_MODE_REQUIRED");
    const resolvedPositionIdx = await resolvePositionIdx({ symbol, side, explicitPositionIdx: positionIdx });

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
          stopLoss: String(sl),
          positionIdx: resolvedPositionIdx,
        });
        slSet = true;
      }
    }

    const tpOrderIds = [];
    const closeSide = side === "Buy" ? "Sell" : "Buy";
    const tpRows = Array.isArray(tps) ? tps.slice(0, 3) : [];
    const step = filters?.qtyStep;

    function buildTpQtys(totalQty, legCount) {
      if (!(Number.isFinite(totalQty) && totalQty > 0) || legCount <= 0) return [];
      if (legCount === 1) return [totalQty];
      const ratios = legCount === 2 ? [0.5, 0.5] : [0.4, 0.3, 0.3];
      const out = [];
      let allocated = 0;
      for (let i = 0; i < legCount; i += 1) {
        if (i === legCount - 1) {
          out.push(Math.max(0, totalQty - allocated));
          continue;
        }
        const raw = totalQty * ratios[i];
        const rounded = Number.isFinite(step) && step > 0 ? roundToStep(raw, step, "floor") : raw;
        const safe = Math.max(0, rounded);
        out.push(safe);
        allocated += safe;
      }
      return out;
    }

    const tpQtys = buildTpQtys(q, tpRows.length);

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
      confirm: await waitForConfirmation({ symbol }),
    };
  }

  async function waitForConfirmation({ symbol, timeoutMs = 3000, intervalMs = 300 } = {}) {
    const started = Date.now();
    let lastError = null;
    while ((Date.now() - started) <= timeoutMs) {
      try {
        const [positions, orders] = await Promise.all([getPositionsRaw({ symbol }), getOpenOrders({ symbol })]);
        return { ok: true, waitedMs: Date.now() - started, positions, orders };
      } catch (err) {
        lastError = String(err?.message || err || 'unknown');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { ok: false, reason: 'CONFIRM_TIMEOUT', detail: lastError };
  }

  async function sync({ symbol, closedPnlLimit = 20 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const [positionRes, ordersRes, pnlRes] = await Promise.all([
      privateRest.getPositions({ symbol }),
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
    const rows = await getPositionsRaw({ symbol });
    return rows.filter(isMeaningfulPosition);
  }

  async function getPositionsRaw({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getPositions({ symbol });
    return (res?.result?.list || []).map(normalizePosition);
  }

  async function getOpenOrders({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getOrdersRealtime({ category: "linear", symbol });
    return (res?.result?.list || []).map(normalizeOrder).filter(isActiveOrder);
  }

  async function getClosedPnl({ symbol, limit = 20 } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.getClosedPnl({ category: "linear", symbol, limit: String(limit) });
    return res?.result?.list || [];
  }

  async function cancelAll({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const res = await privateRest.cancelAll({ category: "linear", symbol });
    return { ok: true, result: res?.result || null, confirm: await waitForConfirmation({ symbol }) };
  }

  async function closePositionMarket({ symbol } = {}) {
    if (!enabled()) throw new Error("trade_disabled");
    const positions = await getPositions({ symbol });
    const rows = positions.filter(isMeaningfulPosition);
    const results = [];
    for (const row of rows) {
      const size = Number(row?.size || 0);
      if (!Number.isFinite(size) || size <= 0) continue;
      const side = String(row?.side || "").toLowerCase() === "buy" ? "Sell" : "Buy";
      const positionIdx = await resolvePositionIdx({ symbol: row.symbol, side, explicitPositionIdx: row?.positionIdx });
      const { qty } = await normalizeQtyPrice(row.symbol, size, null, { qtyMode: "floor" });
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const res = await privateRest.placeOrder({
        category: "linear",
        symbol: row.symbol,
        side,
        orderType: "Market",
        qty: String(qty),
        timeInForce: "IOC",
        reduceOnly: true,
        closeOnTrigger: true,
        positionIdx,
      });
      results.push(res?.result || null);
    }
    return { ok: true, closed: results.length, results, confirm: await waitForConfirmation({ symbol }) };
  }

  async function panicClose({ symbol } = {}) {
    await cancelAll({ symbol });
    return closePositionMarket({ symbol });
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

  function getPreflightStatus() {
    return { ...preflight };
  }

  return {
    enabled,
    getStatus,
    setExecutionMode,
    getExecutionMode,
    setKillSwitch,
    getKillSwitch,
    setActiveSymbol,
    getActiveSymbol,
    setGuardrails,
    getGuardrails,
    normalizeQtyPrice,
    openPosition,
    sync,
    getPosition,
    getPositions,
    getOpenOrders,
    getClosedPnl,
    cancelAll,
    cancelAllOrders: cancelAll,
    closePositionMarket,
    closePosition: closePositionMarket,
    panicClose,
    detectPositionMode,
    getHedgeModeSnapshot,
    ensureHedgeMode,
    ensureIsolated,
    getPreflightStatus,
    ensureIsolatedPreflight,
    getOrderById,
    getExecutionsByOrderId,
    resolvePositionIdx,
    createHedgeOrders,
    placeEntryMarket: async (botName, symbol, side, notionalUSD, leverage) => {
      if (!enabled()) throw new Error("TRADE_DISABLED");
      const safeNotional = Math.min(100, Math.max(1, Number(notionalUSD || 0)));
      const pxHint = 1;
      const qty = safeNotional / pxHint;
      return openPosition({ symbol, side, qty, leverage: Math.min(10, Number(leverage || 1)) });
    },
    placeTpLadder: async (botName, symbol, side, qty, tps = []) => {
      const closeSide = side === "Buy" ? "Sell" : "Buy";
      const results = [];
      for (const tp of tps.slice(0, 3)) {
        results.push(await placeReduceLimit({ symbol, side: closeSide, qty, price: tp?.price }));
      }
      return results;
    },
    setStopLoss: async (botName, symbol, side, slPrice) => privateRest.setTradingStop({ category: "linear", symbol, tpslMode: "Full", slOrderType: "Market", slTriggerBy: "MarkPrice", stopLoss: String(slPrice), positionIdx: await resolvePositionIdx({ symbol, side }) }),
    fetchPositions: getPositions,
    fetchOrders: getOpenOrders,
    fetchHistory: getClosedPnl,
  };
}

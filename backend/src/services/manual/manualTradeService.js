import { calcTpSl } from '../momentum/momentumUtils.js';
import { createBybitRest } from '../../bybitRest.js';

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeError(error) {
  const notional = String(error?.message || '').match(/NOTIONAL_LIMIT_EXCEEDED:([0-9.]+)>([0-9.]+)/);
  if (error?.code === 'NOTIONAL_LIMIT_EXCEEDED' || notional) {
    const limit = Number(error?.limit ?? notional?.[2]);
    const actualNotional = Number(error?.notional ?? notional?.[1]);
    return {
      message: 'NOTIONAL_LIMIT_EXCEEDED',
      retCode: null,
      retMsg: null,
      code: 'NOTIONAL_LIMIT_EXCEEDED',
      limit: Number.isFinite(limit) ? limit : null,
      notional: Number.isFinite(actualNotional) ? actualNotional : null,
    };
  }
  const retCode = error?.payload?.response?.retCode;
  const retMsg = error?.payload?.response?.retMsg;
  return {
    message: String(error?.message || error || 'unknown'),
    retCode: Number.isFinite(Number(retCode)) ? Number(retCode) : null,
    retMsg: retMsg || null,
  };
}

export function createManualTradeService({ tradeExecutor, marketData, logger = console }) {
  const bybitRest = createBybitRest({ logger });

  function isDemo() {
    return String(tradeExecutor?.getExecutionMode?.() || '').toLowerCase() === 'demo';
  }

  async function readQuoteFromStore(symbol) {
    const snap = marketData.getSnapshot(symbol) || {};
    const markPrice = toNumber(snap.markPrice);
    const lastPrice = toNumber(snap.lastPrice);
    if (markPrice > 0 || lastPrice > 0) {
      return { ok: true, markPrice: markPrice || null, lastPrice: lastPrice || null, source: 'market-store', tsMs: Number(snap.tsMs || Date.now()) };
    }
    return { ok: false, reason: 'STORE_EMPTY' };
  }

  async function readQuoteFromRest(symbol) {
    try {
      const ticker = await bybitRest.getTicker({ symbol });
      const markPrice = toNumber(ticker?.markPrice);
      const lastPrice = toNumber(ticker?.lastPrice);
      if (markPrice > 0 || lastPrice > 0) {
        return { ok: true, markPrice: markPrice || null, lastPrice: lastPrice || null, source: 'rest-ticker', tsMs: Date.now() };
      }
      return { ok: false, reason: 'REST_NO_PRICE' };
    } catch (error) {
      return { ok: false, reason: 'REST_ERROR', detail: String(error?.message || error) };
    }
  }

  async function getQuote({ symbol, timeoutMs = 2000 } = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    if (!normalizedSymbol) return { ok: false, error: 'SYMBOL_REQUIRED' };

    const started = Date.now();
    let lastDetail = 'NO_DATA';
    while ((Date.now() - started) < timeoutMs) {
      const fromStore = await readQuoteFromStore(normalizedSymbol);
      if (fromStore.ok) return { ok: true, symbol: normalizedSymbol, ...fromStore };
      lastDetail = fromStore.reason || lastDetail;
      await new Promise((r) => setTimeout(r, 150));
    }

    const fromRest = await readQuoteFromRest(normalizedSymbol);
    if (fromRest.ok) return { ok: true, symbol: normalizedSymbol, ...fromRest };
    return { ok: false, error: 'NO_PRICE', detail: fromRest.detail || `${lastDetail}; ${fromRest.reason || 'REST_FAILED'}` };
  }

  async function placeDemoOrder({ symbol, side, marginUSDT, leverage, tpRoiPct, slRoiPct }) {
    if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' };
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const normalizedSide = String(side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const quote = await getQuote({ symbol: normalizedSymbol, timeoutMs: 2500 });
    const entryPrice = toNumber(quote?.markPrice) || toNumber(quote?.lastPrice) || 0;
    if (!(entryPrice > 0)) return { ok: false, error: 'NO_PRICE', detail: quote?.detail || 'mark/last missing' };
    const qty = (Number(marginUSDT || 0) * Number(leverage || 0)) / entryPrice;
    if (!(qty > 0)) return { ok: false, error: 'BAD_QTY' };

    const prices = calcTpSl({ side: normalizedSide, entryPrice, tpRoiPct, slRoiPct, leverage });
    try {
      await tradeExecutor.ensureIsolated?.({ symbol: normalizedSymbol });
      const result = await tradeExecutor.openPosition({
        symbol: normalizedSymbol,
        side: normalizedSide === 'LONG' ? 'Buy' : 'Sell',
        qty,
        leverage: Number(leverage),
        slPrice: prices.slPrice,
        tps: [{ price: prices.tpPrice }],
        priceHint: entryPrice,
      });
      return {
        ok: true,
        quote,
        entry: { orderId: result?.entryOrderId || null, filledQty: result?.qty || qty, avgPrice: result?.avgPrice || entryPrice },
        tpsl: { slAttached: Boolean(prices.slPrice), tpOrdersPlaced: prices.tpPrice ? 1 : 0 },
        confirm: result?.confirm || null,
      };
    } catch (error) {
      const normalized = normalizeError(error);
      logger?.warn?.({ error: normalized }, 'manual demo order failed');
      if (normalized.code === 'NOTIONAL_LIMIT_EXCEEDED') {
        return { ok: false, error: normalized.code, limit: normalized.limit, notional: normalized.notional };
      }
      return { ok: false, error: normalized.message, retCode: normalized.retCode, retMsg: normalized.retMsg };
    }
  }

  async function closeDemoPosition({ symbol }) {
    if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' };
    try {
      const normalizedSymbol = String(symbol || '').toUpperCase();
      const closeFn = typeof tradeExecutor.closePosition === 'function'
        ? tradeExecutor.closePosition.bind(tradeExecutor)
        : typeof tradeExecutor.closePositionMarket === 'function'
          ? tradeExecutor.closePositionMarket.bind(tradeExecutor)
          : null;
      if (!closeFn) return { ok: false, error: 'CLOSE_METHOD_UNAVAILABLE' };
      return { ok: true, details: await closeFn({ symbol: normalizedSymbol }) };
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'NOTIONAL_LIMIT_EXCEEDED') {
        return { ok: false, error: normalized.code, limit: normalized.limit, notional: normalized.notional };
      }
      return { ok: false, error: normalized.message, retCode: normalized.retCode, retMsg: normalized.retMsg };
    }
  }

  async function cancelDemoOrders({ symbol }) {
    if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' };
    try {
      const normalizedSymbol = String(symbol || '').toUpperCase();
      const cancelFn = typeof tradeExecutor.cancelAllOrders === 'function'
        ? tradeExecutor.cancelAllOrders.bind(tradeExecutor)
        : typeof tradeExecutor.cancelAll === 'function'
          ? tradeExecutor.cancelAll.bind(tradeExecutor)
          : null;
      if (!cancelFn) return { ok: false, error: 'CANCEL_METHOD_UNAVAILABLE' };
      return { ok: true, details: await cancelFn({ symbol: normalizedSymbol }) };
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'NOTIONAL_LIMIT_EXCEEDED') {
        return { ok: false, error: normalized.code, limit: normalized.limit, notional: normalized.notional };
      }
      return { ok: false, error: normalized.message, retCode: normalized.retCode, retMsg: normalized.retMsg };
    }
  }

  async function getDemoState({ symbol }) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const [position, orders, quote] = await Promise.all([
      tradeExecutor.getPosition?.({ symbol: normalizedSymbol }),
      tradeExecutor.getOpenOrders?.({ symbol: normalizedSymbol }),
      getQuote({ symbol: normalizedSymbol, timeoutMs: 1500 }),
    ]);
    return { ok: true, position: position || null, orders: orders || [], quote };
  }

  return { placeDemoOrder, closeDemoPosition, cancelDemoOrders, getDemoState, getQuote };
}

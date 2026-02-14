import { calcTpSl } from '../momentum/momentumUtils.js';

export function createManualTradeService({ tradeExecutor, marketData, logger = console }) {
  function isDemo() { return String(tradeExecutor?.getExecutionMode?.() || '').toLowerCase() === 'demo'; }
  async function placeDemoOrder({ symbol, side, marginUSDT, leverage, tpRoiPct, slRoiPct }) {
    if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' };
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const normalizedSide = String(side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const snap = marketData.getSnapshot(normalizedSymbol) || {};
    const entryPrice = Number(snap.markPrice || snap.lastPrice || 0);
    if (!(entryPrice > 0)) return { ok: false, error: 'NO_PRICE' };
    const qty = (Number(marginUSDT || 0) * Number(leverage || 0)) / entryPrice;
    const prices = calcTpSl({ side: normalizedSide, entryPrice, tpRoiPct, slRoiPct, leverage });
    try {
      await tradeExecutor.ensureIsolated?.({ symbol: normalizedSymbol });
      const result = await tradeExecutor.openPosition({ symbol: normalizedSymbol, side: normalizedSide === 'LONG' ? 'Buy' : 'Sell', qty, leverage: Number(leverage), slPrice: prices.slPrice, tps: [{ price: prices.tpPrice }], priceHint: entryPrice });
      return { ok: true, entry: { orderId: result?.entryOrderId || null, filledQty: result?.qty || qty, avgPrice: result?.avgPrice || entryPrice }, tpsl: { slAttached: Boolean(prices.slPrice), tpOrdersPlaced: prices.tpPrice ? 1 : 0 } };
    } catch (error) { logger?.warn?.({ error }, 'manual demo order failed'); return { ok: false, error: String(error?.message || error) }; }
  }
  async function closeDemoPosition({ symbol }) { if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' }; try { return { ok: true, details: await tradeExecutor.closePosition({ symbol: String(symbol || '').toUpperCase() }) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; } }
  async function cancelDemoOrders({ symbol }) { if (!isDemo()) return { ok: false, error: 'DEMO_ONLY' }; try { return { ok: true, details: await tradeExecutor.cancelAllOrders({ symbol: String(symbol || '').toUpperCase() }) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; } }
  async function getDemoState({ symbol }) { const normalizedSymbol = String(symbol || '').toUpperCase(); const [position, orders] = await Promise.all([tradeExecutor.getPosition?.({ symbol: normalizedSymbol }), tradeExecutor.getOpenOrders?.({ symbol: normalizedSymbol })]); return { ok: true, position: position || null, orders: orders || [] }; }
  return { placeDemoOrder, closeDemoPosition, cancelDemoOrders, getDemoState };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBybitTradeExecutor } from '../src/bybitTradeExecutor.js';

function makePrivateRest({ positions = [], accountInfo = {}, calls = {} } = {}) {
  const state = { positions: [...positions] };
  return {
    enabled: true,
    getPositions: async () => ({ result: { list: state.positions } }),
    getOrdersRealtime: async () => ({ result: { list: [] } }),
    getClosedPnl: async () => ({ result: { list: [] } }),
    placeOrder: async () => ({ result: { orderId: 'oid' } }),
    setTradingStop: async () => ({ result: {} }),
    setLeverage: async () => ({ result: {} }),
    cancelAll: async () => ({ result: {} }),
    switchIsolated: async () => {
      calls.switchIsolated = (calls.switchIsolated || 0) + 1;
      state.positions = state.positions.map((p) => ({ ...p, tradeMode: 1, marginMode: 'isolated' }));
      return { result: {} };
    },
    switchPositionMode: async () => {
      calls.switchPositionMode = (calls.switchPositionMode || 0) + 1;
      state.positions = state.positions.map((p, idx) => ({ ...p, positionIdx: idx === 0 ? 1 : 2 }));
      return { result: {} };
    },
    getAccountInfo: async () => ({ result: { list: [accountInfo] } }),
  };
}

test('ensureIsolated enforces isolated margin and caches success', async () => {
  const calls = {};
  const privateRest = makePrivateRest({
    positions: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0', positionIdx: 1, tradeMode: 0, marginMode: 'cross' }],
    calls,
  });
  const ex = createBybitTradeExecutor({ privateRest, instruments: null });
  ex.setExecutionMode('demo');
  const first = await ex.ensureIsolated({ symbol: 'BTCUSDT' });
  const second = await ex.ensureIsolated({ symbol: 'BTCUSDT' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls.switchIsolated, 1);
});

test('ensureHedgeMode sets hedge mode when account is one-way', async () => {
  const calls = {};
  const privateRest = makePrivateRest({
    positions: [{ symbol: 'BTCUSDT', side: 'Buy', size: '0', positionIdx: 0, tradeMode: 1, marginMode: 'isolated' }],
    accountInfo: { unifiedMarginStatus: 1 },
    calls,
  });
  const ex = createBybitTradeExecutor({ privateRest, instruments: null });
  ex.setExecutionMode('demo');
  const out = await ex.ensureHedgeMode({ symbol: 'BTCUSDT' });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'HEDGE');
  assert.equal(calls.switchPositionMode, 1);
});


test('getHedgeModeSnapshot caches mode for ttl window', async () => {
  const calls = { positions: 0 };
  const privateRest = {
    enabled: true,
    getPositions: async () => { calls.positions += 1; return { result: { list: [{ symbol: 'BTCUSDT', positionIdx: 1, tradeMode: 1, marginMode: 'isolated' }] } }; },
    getOrdersRealtime: async () => ({ result: { list: [] } }),
    getClosedPnl: async () => ({ result: { list: [] } }),
    placeOrder: async () => ({ result: { orderId: 'oid' } }),
    setTradingStop: async () => ({ result: {} }),
    setLeverage: async () => ({ result: {} }),
    cancelAll: async () => ({ result: {} }),
    switchIsolated: async () => ({ result: {} }),
    switchPositionMode: async () => ({ result: {} }),
    getAccountInfo: async () => ({ result: { list: [{ unifiedMarginStatus: 1 }] } }),
  };
  const ex = createBybitTradeExecutor({ privateRest, instruments: null });
  ex.setExecutionMode('demo');
  const a = await ex.getHedgeModeSnapshot({ symbol: 'BTCUSDT' });
  const b = await ex.getHedgeModeSnapshot({ symbol: 'BTCUSDT' });
  assert.equal(a.mode, 'HEDGE');
  assert.equal(b.mode, 'HEDGE');
  assert.equal(calls.positions, 1);
});

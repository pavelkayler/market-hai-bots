import test from 'node:test';
import assert from 'node:assert/strict';
import { calcChange, calcTpSl, calcVol24h, roundByTickForSide } from '../src/services/momentum/momentumUtils.js';
import { createMomentumInstance } from '../src/services/momentum/momentumInstance.js';
import { createMomentumManager } from '../src/services/momentum/momentumManager.js';

test('calc change', () => {
  assert.ok(Math.abs(calcChange(110, 100) - 0.1) < 1e-9);
  assert.equal(calcChange(100, 0), null);
});

test('tp/sl from roi leverage', () => {
  const long = calcTpSl({ side: 'LONG', entryPrice: 100, tpRoiPct: 10, slRoiPct: 10, leverage: 10 });
  assert.equal(long.tpPrice, 101);
  assert.equal(long.slPrice, 99);
});

test('volatility high/low and fallback', () => {
  assert.ok(Math.abs(calcVol24h({ highPrice24h: 110, lowPrice24h: 100 }).vol24h - 0.1) < 1e-9);
  const fb = calcVol24h({ price24hPcnt: -0.12 });
  assert.equal(fb.vol24h, 0.12);
  assert.equal(fb.usedFallback, true);
});

test('manager rejects invalid windows and allows 1/3/5', async () => {
  const md = { onTick() {}, getEligibleSymbols: () => [], setActiveIntervals() {}, getStatus: () => ({}) };
  const manager = createMomentumManager({ marketData: md, sqlite: { getTrades: async () => ({ trades: [], total: 0 }) } });
  assert.equal((await manager.start({ windowMinutes: 15 })).ok, false);
  assert.equal((await manager.start({ windowMinutes: 3 })).ok, true);
});

test('manager blocks demo/real momentum start when hedge mode preflight fails', async () => {
  const md = { onTick() {}, getEligibleSymbols: () => [], setActiveIntervals() {}, getStatus: () => ({}) };
  const manager = createMomentumManager({
    marketData: md,
    sqlite: { getTrades: async () => ({ trades: [], total: 0 }) },
    tradeExecutor: {
      enabled: () => true,
      ensureHedgeMode: async () => ({ ok: false, error: 'HEDGE MODE REQUIRED: enable Hedge (dual-side) in Bybit account settings, then restart.' }),
      getPreflightStatus: () => ({ hedgeMode: 'ONE_WAY' }),
    },
  });
  const out = await manager.start({ windowMinutes: 1, mode: 'demo' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'HEDGE_MODE_REQUIRED');
});

test('hold + trend + turnover baseline + manual cancel', async () => {
  const snaps = new Map();
  const sqlite = { saveTrade() {}, saveSignal() {} };
  const md = {
    getSnapshot: (s) => snaps.get(s),
    getCandleBaseline: () => ({ ok: true, prevClose: 100, prevOiValue: 1000, prevTurnoverUSDT: 100, medianPrevTurnoverUSDT: 120, curTurnoverUSDT: 260, curCandleStartMs: 0 }),
    getTrendOk: () => true,
    getOiAgeSec: () => 1,
  };
  const inst = createMomentumInstance({ id: 'a', config: { windowMinutes: 1, priceThresholdPct: 1, oiThresholdPct: 1, holdSeconds: 2, baselineFloorUSDT: 100, turnoverSpikePct: 100 }, marketData: md, sqlite });
  snaps.set('X', { markPrice: 102, lastPrice: 102, oiValue: 1020, turnover24h: 1, vol24h: 0.1, tickSize: 0.1 });
  await inst.onTick({ ts: 1000, sec: 60 }, ['X']);
  let st = inst.getSnapshot();
  assert.equal(st.pendingOrders.length, 0);
  await inst.onTick({ ts: 2000, sec: 61 }, ['X']);
  st = inst.getSnapshot();
  assert.equal(st.pendingOrders.length, 1);
  assert.equal(inst.cancelEntry('X').ok, true);
});

test('trigger fills on crossing', async () => {
  const snaps = new Map();
  const sqlite = { saveTrade() {}, saveSignal() {} };
  const md = {
    getSnapshot: (s) => snaps.get(s),
    getCandleBaseline: () => ({ ok: true, prevClose: 100, prevOiValue: 1000, prevTurnoverUSDT: 100, medianPrevTurnoverUSDT: 100, curTurnoverUSDT: 220, curCandleStartMs: 0 }),
    getTrendOk: () => true,
    getOiAgeSec: () => 1,
  };
  const inst = createMomentumInstance({ id: 'cross', config: { windowMinutes: 1, priceThresholdPct: 1, oiThresholdPct: 1, holdSeconds: 1, entryOffsetPct: -0.5, baselineFloorUSDT: 100 }, marketData: md, sqlite });
  snaps.set('X', { markPrice: 102, lastPrice: 102, oiValue: 1020, tickSize: 0.1 });
  await inst.onTick({ ts: 1000, sec: 60 }, ['X']);
  snaps.set('X', { markPrice: 101.6, lastPrice: 101.6, oiValue: 1020, tickSize: 0.1 });
  await inst.onTick({ ts: 2000, sec: 61 }, ['X']);
  let st = inst.getSnapshot();
  assert.equal(st.openPositions.length, 1);
  snaps.set('X', { markPrice: 101.4, lastPrice: 101.4, oiValue: 1020, tickSize: 0.1 });
  await inst.onTick({ ts: 3000, sec: 62 }, ['X']);
  st = inst.getSnapshot();
  assert.equal(st.openPositions.length, 1);
});

test('oi stale blocks entries', async () => {
  const snaps = new Map();
  const sqlite = { saveTrade() {}, saveSignal() {} };
  const md = {
    getSnapshot: (s) => snaps.get(s),
    getCandleBaseline: () => ({ ok: true, prevClose: 100, prevOiValue: 1000, prevTurnoverUSDT: 100, medianPrevTurnoverUSDT: 100, curTurnoverUSDT: 220, curCandleStartMs: 0 }),
    getTrendOk: () => true,
    getOiAgeSec: () => 99,
  };
  const inst = createMomentumInstance({ id: 'stale', config: { windowMinutes: 1, holdSeconds: 1, oiMaxAgeSec: 10, baselineFloorUSDT: 100 }, marketData: md, sqlite });
  snaps.set('X', { markPrice: 110, lastPrice: 110, oiValue: 1200, tickSize: 0.1 });
  await inst.onTick({ ts: 1000, sec: 60 }, ['X']);
  assert.equal(inst.getSnapshot().pendingOrders.length, 0);
});

test('tick rounding floors long and ceils short', () => {
  assert.equal(roundByTickForSide(100.09, 0.05, 'LONG'), 100.05);
  assert.equal(roundByTickForSide(100.01, 0.05, 'SHORT'), 100.05);
});

test('signals use last price and oi value lookback', async () => {
  const snaps = new Map();
  const sqlite = { saveTrade() {}, saveSignal() {} };
  const md = {
    getSnapshot: (s) => snaps.get(s),
    getCandleBaseline: () => ({ ok: true, prevClose: 90, prevOiValue: 800, prevTurnoverUSDT: 100, medianPrevTurnoverUSDT: 100, curTurnoverUSDT: 220, curCandleStartMs: 0 }),
    getTrendOk: () => true,
    getOiAgeSec: () => 1,
  };
  const inst = createMomentumInstance({ id: 'signal-source', config: { windowMinutes: 1, priceThresholdPct: 5, oiThresholdPct: 1, holdSeconds: 1, baselineFloorUSDT: 100 }, marketData: md, sqlite });
  snaps.set('X', { markPrice: 100, lastPrice: 100, oiValue: 1000, tickSize: 0.1 });
  await inst.onTick({ ts: 1000, sec: 60 }, ['X']);
  const row = inst.getSnapshot().signalView.find((r) => r.symbol === 'X');
  assert.ok(row);
  assert.ok(Math.abs(row.priceChange - ((100 / 90) - 1)) < 1e-9);
  assert.ok(Math.abs(row.oiChange - ((1000 / 800) - 1)) < 1e-9);
});

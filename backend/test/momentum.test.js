import test from 'node:test';
import assert from 'node:assert/strict';
import { calcChange, calcTpSl, calcVol24h } from '../src/services/momentum/momentumUtils.js';
import { createMomentumInstance } from '../src/services/momentum/momentumInstance.js';

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

test('pending order has no ttl cancel and can be manually cancelled', async () => {
  const snaps = new Map();
  const prev = { tsSec: 0, markPrice: 100, openInterest: 1000 };
  let busySignals = 0;
  const sqlite = { saveTrade() {}, saveSignal(row) { if (row.action === 'SYMBOL_BUSY') busySignals += 1; } };
  const md = {
    getSnapshot: (s) => snaps.get(s),
    getAtWindow: () => prev,
  };
  const inst = createMomentumInstance({ id: 'a', config: { windowMinutes: 1, cooldownMinutes: 60, priceThresholdPct: 1, oiThresholdPct: 1 }, marketData: md, sqlite });

  snaps.set('X', { markPrice: 102, openInterest: 1020, turnover24h: 1, vol24h: 0.1 });
  inst.onTick({ ts: 0, sec: 60 }, ['X']);
  let st = inst.getSnapshot();
  assert.equal(st.pendingOrders.length, 1);

  // still pending after long time (no TTL)
  snaps.set('X', { markPrice: 105, openInterest: 1025, turnover24h: 1, vol24h: 0.1 });
  inst.onTick({ ts: 180_000, sec: 240 }, ['X']);
  st = inst.getSnapshot();
  assert.equal(st.pendingOrders.length, 1);
  assert.equal(busySignals, 1);

  const cancel = inst.cancelEntry('X');
  assert.equal(cancel.ok, true);
  st = inst.getSnapshot();
  assert.equal(st.pendingOrders.length, 0);
});

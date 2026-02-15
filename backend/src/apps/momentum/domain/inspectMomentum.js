function toPct(now, prev) {
  const n = Number(now);
  const p = Number(prev);
  if (!(Number.isFinite(n) && Number.isFinite(p) && p > 0)) return null;
  return ((n / p) - 1) * 100;
}

const fmt = (n, digits = 3, suffix = '') => (Number.isFinite(Number(n)) ? `${Number(n).toFixed(digits)}${suffix}` : '-');

export function inspectMomentumSymbol({ symbol, config = {}, marketData }) {
  const snap = marketData.getSnapshot?.(symbol) || {};
  const interval = Number(config.windowMinutes || 1);
  const baseline = marketData.getCandleBaseline?.(symbol, interval) || { ok: false, reason: 'NO_PREV_CANDLE' };
  const turnoverGate = marketData.getTurnoverGate?.(symbol, interval) || {};

  const priceNow = Number(snap.lastPrice || 0);
  const markPrice = Number(snap.markPrice || 0);
  const turnover24h = Number(snap.turnover24h || 0);
  const vol24h = Number.isFinite(Number(snap.vol24h))
    ? Number(snap.vol24h)
    : (Number.isFinite(Number(snap.price24hPcnt))
      ? Number(snap.price24hPcnt) * 100
      : (Number(snap.lowPrice24h) > 0 && Number(snap.highPrice24h) > 0 ? ((Number(snap.highPrice24h) / Number(snap.lowPrice24h)) - 1) * 100 : null));

  const prevClose = baseline.ok ? Number(baseline.prevClose || 0) : null;
  const prevOiValue = baseline.ok ? Number(baseline.prevOiValue || 0) : null;
  const oiValue = Number(snap.oiValue || 0);
  const oiAgeSec = Number(marketData.getOiAgeSec?.(symbol));
  const priceChangePctW = baseline.ok ? toPct(priceNow, prevClose) : null;
  const oiChangePctW = baseline.ok ? toPct(oiValue, prevOiValue) : null;

  const prevTurnoverUSDT = Number(turnoverGate.prevTurnoverUSDT);
  const curTurnoverUSDT = Number(turnoverGate.curTurnoverUSDT);
  const medianPrevTurnoverUSDT = Number(turnoverGate.medianTurnoverUSDT);
  const turnoverSpikeActualPct = Number.isFinite(medianPrevTurnoverUSDT) && medianPrevTurnoverUSDT > 0
    ? ((prevTurnoverUSDT / medianPrevTurnoverUSDT) - 1) * 100
    : null;

  const thresholds = {
    priceChangePctW: { value: Number(config.priceThresholdPct || 0), op: '>=' },
    oiChangePctW: { value: Number(config.oiThresholdPct || 0), op: '>=' },
    oiAgeSec: { value: Number(config.oiMaxAgeSec || 0), op: '<=' },
    turnoverSpikePct: { value: Number(config.turnoverSpikePct || 0), op: '>=' },
    baselineFloorUSDT: { value: Number(config.baselineFloorUSDT || 0), op: '>=' },
    priceOkShort: { value: -Number(config.priceThresholdPct || 0), op: '<=' },
    oiOkShort: { value: -Number(config.oiThresholdPct || 0), op: '<=' },
  };

  const priceOkLong = Number(priceChangePctW) >= Number(config.priceThresholdPct || 0);
  const priceOkShort = Number(priceChangePctW) <= -Number(config.priceThresholdPct || 0);
  const oiOkLong = Number(oiChangePctW) >= Number(config.oiThresholdPct || 0);
  const oiOkShort = Number(oiChangePctW) <= -Number(config.oiThresholdPct || 0);
  const oiFreshOk = Number.isFinite(oiAgeSec) && oiAgeSec <= Number(config.oiMaxAgeSec || 0);
  const baselineFloorOk = Number(config.baselineFloorUSDT || 0) <= 0
    || (Number.isFinite(prevTurnoverUSDT) && prevTurnoverUSDT >= Number(config.baselineFloorUSDT || 0));
  const turnoverSpikeEnabled = Number(config.turnoverSpikePct || 0) > 0;
  const turnoverSpikeOk = !turnoverSpikeEnabled
    || (Number.isFinite(turnoverSpikeActualPct) && turnoverSpikeActualPct >= Number(config.turnoverSpikePct || 0));
  const turnoverGateOkLong = baselineFloorOk && turnoverSpikeOk;

  const checks = {
    baselineReady: { pass: Boolean(baseline.ok), reason: baseline.ok ? 'ok' : (baseline.reason || 'baseline missing') },
    priceChangePctW: { pass: priceOkLong, reason: `LONG ${fmt(priceChangePctW, 3, '%')}` },
    oiChangePctW: { pass: oiOkLong, reason: `LONG ${fmt(oiChangePctW, 3, '%')}` },
    priceOkLong: { pass: priceOkLong, reason: `priceChangePctW=${fmt(priceChangePctW, 3, '%')}` },
    priceOkShort: { pass: priceOkShort, reason: `priceChangePctW=${fmt(priceChangePctW, 3, '%')}` },
    oiOkLong: { pass: oiOkLong, reason: `oiChangePctW=${fmt(oiChangePctW, 3, '%')}` },
    oiOkShort: { pass: oiOkShort, reason: `oiChangePctW=${fmt(oiChangePctW, 3, '%')}` },
    oiAgeSec: { pass: oiFreshOk, reason: `oiAgeSec=${fmt(oiAgeSec, 1, 's')}` },
    oiFreshOk: { pass: oiFreshOk, reason: `oiAgeSec=${fmt(oiAgeSec, 1, 's')}` },
    baselineFloorUSDT: { pass: baselineFloorOk, reason: `prevTurnoverUSDT=${fmt(prevTurnoverUSDT, 2)}` },
    turnoverSpikePct: { pass: turnoverSpikeOk, reason: `actual=${fmt(turnoverSpikeActualPct, 3, '%')}` },
    turnoverGateOkLong: { pass: turnoverGateOkLong, reason: `floor=${baselineFloorOk ? 'ok' : 'fail'}, spike=${turnoverSpikeOk ? 'ok' : 'fail'}` },
  };

  const metrics = {
    markPrice: { value: markPrice, human: fmt(markPrice, 6), unit: 'USDT' },
    lastPrice: { value: priceNow, human: fmt(priceNow, 6), unit: 'USDT' },
    turnover24h: { value: turnover24h, human: fmt(turnover24h, 2), unit: 'USDT' },
    vol24h: { value: vol24h, human: fmt(vol24h, 3, '%'), unit: '%' },
    oiValue: { value: oiValue, human: fmt(oiValue, 2), unit: 'USDT' },
    oiAgeSec: { value: oiAgeSec, human: fmt(oiAgeSec, 1, 's'), unit: 'sec' },
    prevClose: { value: prevClose, human: fmt(prevClose, 6), unit: 'USDT' },
    priceChangePctW: { value: priceChangePctW, human: fmt(priceChangePctW, 3, '%'), unit: '%' },
    prevOiValue: { value: prevOiValue, human: fmt(prevOiValue, 2), unit: 'USDT' },
    oiChangePctW: { value: oiChangePctW, human: fmt(oiChangePctW, 3, '%'), unit: '%' },
    prevTurnoverUSDT: { value: prevTurnoverUSDT, human: fmt(prevTurnoverUSDT, 2), unit: 'USDT' },
    medianPrevTurnoverUSDT: { value: medianPrevTurnoverUSDT, human: fmt(medianPrevTurnoverUSDT, 2), unit: 'USDT' },
    curTurnoverUSDT: { value: curTurnoverUSDT, human: fmt(curTurnoverUSDT, 2), unit: 'USDT' },
    turnoverSpikePct: { value: turnoverSpikeActualPct, human: fmt(turnoverSpikeActualPct, 3, '%'), unit: '%' },
  };

  const infoKeys = new Set(['baselineReady']);
  for (const [key, row] of Object.entries(checks)) {
    row.status = infoKeys.has(key) ? 'INFO' : (row.pass ? 'PASS' : 'FAIL');
  }
  const failed = Object.entries(checks).filter(([, c]) => c.status === 'FAIL').map(([k, c]) => `${k}: ${c.reason}`);
  return {
    ok: true,
    symbol,
    tsMs: Date.now(),
    source: 'BT',
    metrics,
    thresholds,
    checks,
    summary: { ready: failed.length === 0, topFailReasons: failed.slice(0, 10) },
  };
}

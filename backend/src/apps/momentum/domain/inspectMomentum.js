export function inspectMomentumSymbol({ symbol, config = {}, marketData }) {
  const snap = marketData.getSnapshot?.(symbol) || {};
  const baseline = marketData.getCandleBaseline?.(symbol, config.windowMinutes) || { ok: false, reason: 'NO_PREV_CANDLE' };
  const calcChange = (now, prev) => {
    const n = Number(now); const p = Number(prev);
    if (!(Number.isFinite(n) && Number.isFinite(p) && p > 0)) return null;
    return ((n / p) - 1) * 100;
  };
  const priceChangePctW = baseline.ok ? calcChange(snap.lastPrice, baseline.prevClose) : null;
  const oiChangePctW = baseline.ok ? calcChange(snap.oiValue, baseline.prevOiValue) : null;
  const oiAgeSec = Number(marketData.getOiAgeSec?.(symbol));

  const thresholds = {
    priceChangePctW: { value: Number(config.priceThresholdPct || 0), op: '>=' },
    oiChangePctW: { value: Number(config.oiThresholdPct || 0), op: '>=' },
    oiAgeSec: { value: Number(config.oiMaxAgeSec || 0), op: '<=' },
    trendConfirmSeconds: { value: Number(config.trendConfirmSeconds || 0), op: '>=' },
  };

  const trendLong = Boolean(marketData.getTrendOk?.(symbol, config.trendConfirmSeconds, 'LONG'));
  const checks = {
    baselineReady: { pass: Boolean(baseline.ok), reason: baseline.ok ? 'ok' : (baseline.reason || 'no baseline') },
    price: { pass: Number(priceChangePctW) >= Number(config.priceThresholdPct || 0), reason: `price=${Number(priceChangePctW || 0).toFixed(3)}%` },
    oi: { pass: Number(oiChangePctW) >= Number(config.oiThresholdPct || 0), reason: `oi=${Number(oiChangePctW || 0).toFixed(3)}%` },
    oiFresh: { pass: Number.isFinite(oiAgeSec) && oiAgeSec <= Number(config.oiMaxAgeSec || 0), reason: `oiAge=${Number(oiAgeSec || 0).toFixed(1)}s` },
    trend: { pass: trendLong, reason: trendLong ? 'trend confirmed' : 'trend not confirmed' },
  };

  const metrics = {
    lastPrice: { value: Number(snap.lastPrice || 0), human: Number(snap.lastPrice || 0).toFixed(6), unit: 'USDT' },
    markPrice: { value: Number(snap.markPrice || 0), human: Number(snap.markPrice || 0).toFixed(6), unit: 'USDT' },
    priceChangePctW: { value: priceChangePctW, human: `${Number(priceChangePctW || 0).toFixed(3)}%`, unit: '%' },
    oiValue: { value: Number(snap.oiValue || 0), human: Number(snap.oiValue || 0).toFixed(2), unit: 'USDT' },
    oiChangePctW: { value: oiChangePctW, human: `${Number(oiChangePctW || 0).toFixed(3)}%`, unit: '%' },
    oiAgeSec: { value: oiAgeSec, human: `${Number(oiAgeSec || 0).toFixed(1)}s`, unit: 'sec' },
  };

  const failed = Object.entries(checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.reason}`);
  return {
    symbol,
    tsMs: Date.now(),
    source: 'BT',
    metrics,
    thresholds,
    checks,
    summary: { ready: failed.length === 0, topFailReasons: failed.slice(0, 5) },
  };
}

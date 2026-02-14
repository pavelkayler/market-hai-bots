import { DEFAULT_MOMENTUM_CONFIG } from './momentumTypes.js';

export function parseFloatSafe(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function calcVol24h(snapshot = {}) {
  const hi = parseFloatSafe(snapshot.highPrice24h);
  const lo = parseFloatSafe(snapshot.lowPrice24h);
  if (hi > 0 && lo > 0) return { vol24h: (hi / lo) - 1, usedFallback: false };
  const p = parseFloatSafe(snapshot.price24hPcnt);
  if (Number.isFinite(p)) return { vol24h: Math.abs(p), usedFallback: true };
  return { vol24h: null, usedFallback: false };
}

export function calcChange(now, prev) {
  if (!(now > 0 && prev > 0)) return null;
  return (now / prev) - 1;
}

export function roiToMovePct(roiPct, leverage) {
  const r = parseFloatSafe(roiPct, 0);
  const l = parseFloatSafe(leverage, 1);
  if (!(l > 0)) return 0;
  return r / l;
}

export function calcTpSl({ side, entryPrice, tpRoiPct, slRoiPct, leverage }) {
  const ep = parseFloatSafe(entryPrice);
  if (!(ep > 0)) return { tpPrice: null, slPrice: null };
  const tpMove = roiToMovePct(tpRoiPct, leverage) / 100;
  const slMove = roiToMovePct(slRoiPct, leverage) / 100;
  if (side === 'LONG') return { tpPrice: ep * (1 + tpMove), slPrice: ep * (1 - slMove) };
  return { tpPrice: ep * (1 - tpMove), slPrice: ep * (1 + slMove) };
}

export function normalizeMomentumConfig(raw = {}) {
  const c = { ...DEFAULT_MOMENTUM_CONFIG, ...(raw || {}) };
  c.mode = ['paper', 'demo', 'real'].includes(String(c.mode)) ? String(c.mode) : 'demo';
  c.directionMode = ['LONG', 'SHORT', 'BOTH'].includes(String(c.directionMode).toUpperCase()) ? String(c.directionMode).toUpperCase() : 'BOTH';
  c.scanMode = ['UNIVERSE', 'SINGLE'].includes(String(c.scanMode).toUpperCase()) ? String(c.scanMode).toUpperCase() : 'UNIVERSE';
  c.singleSymbol = String(c.singleSymbol || '').trim().toUpperCase() || null;
  c.windowMinutes = Math.trunc(parseFloatSafe(c.windowMinutes, 1));
  if (![1, 3, 5].includes(c.windowMinutes)) c.windowMinutes = 1;
  c.priceThresholdPct = Math.max(0.01, parseFloatSafe(c.priceThresholdPct, 0.2));
  c.oiThresholdPct = Math.max(0, parseFloatSafe(c.oiThresholdPct, 0));
  c.turnover24hMin = Math.max(0, parseFloatSafe(c.turnover24hMin, 0));
  c.vol24hMin = Math.max(0, parseFloatSafe(c.vol24hMin, 0));
  const normalizedUniverseSource = String(c.universeSource || '').toUpperCase();
  c.universeSource = /^TIER_\d+$/.test(normalizedUniverseSource)
    ? normalizedUniverseSource
    : (normalizedUniverseSource === 'FAST' ? 'TIER_1' : (normalizedUniverseSource === 'SLOW' ? 'TIER_2' : 'TIER_1'));
  c.leverage = Math.max(1, parseFloatSafe(c.leverage, 3));
  c.marginUsd = Math.max(1, parseFloatSafe(c.marginUsd, 10));
  c.tpRoiPct = Math.max(0.1, parseFloatSafe(c.tpRoiPct, 2));
  c.slRoiPct = Math.max(0.1, parseFloatSafe(c.slRoiPct, 2));
  c.entryOffsetPct = parseFloatSafe(c.entryOffsetPct, -0.01);
  c.turnoverSpikePct = Math.max(0, parseFloatSafe(c.turnoverSpikePct, 0));
  c.baselineFloorUSDT = Math.max(0, parseFloatSafe(c.baselineFloorUSDT, 0));
  c.holdSeconds = Math.max(1, Math.trunc(parseFloatSafe(c.holdSeconds, 1)));
  c.trendConfirmSeconds = Math.max(1, Math.trunc(parseFloatSafe(c.trendConfirmSeconds, 1)));
  c.oiMaxAgeSec = Math.max(1, parseFloatSafe(c.oiMaxAgeSec, 120));
  c.cooldownMinutes = Math.max(1, Math.trunc(parseFloatSafe(c.cooldownMinutes, 60)));
  c.maxNewEntriesPerTick = Math.max(1, Math.trunc(parseFloatSafe(c.maxNewEntriesPerTick, 5)));
  c.entryPriceSource = ['MARK', 'LAST'].includes(String(c.entryPriceSource).toUpperCase()) ? String(c.entryPriceSource).toUpperCase() : 'LAST';
  c.globalSymbolLock = Boolean(c.globalSymbolLock);
  return c;
}

export function roundByTickForSide(price, tickSize, side) {
  const p = parseFloatSafe(price);
  const tick = parseFloatSafe(tickSize);
  if (!(p > 0) || !(tick > 0)) return p;
  const units = p / tick;
  const roundedUnits = side === 'LONG' ? Math.floor(units) : (side === 'SHORT' ? Math.ceil(units) : Math.round(units));
  const out = roundedUnits * tick;
  const precision = Math.max(0, ((String(tick).split('.')[1] || '').length));
  return Number(out.toFixed(precision));
}

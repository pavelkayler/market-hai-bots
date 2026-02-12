import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_PATH = path.resolve(process.cwd(), "backend/data/presets.json");

const PARAM_KEYS = [
  "impulseZ",
  "minSamples",
  "minImpulses",
  "minCorr",
  "entryWindowMs",
  "cooldownSec",
  "edgeMult",
  "confirmZ",
  "riskQtyMultiplier",
];

function now() {
  return Date.now();
}

function clampNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultBounds() {
  return {
    impulseZ: { min: 1, max: 5 },
    minSamples: { min: 30, max: 2000 },
    minImpulses: { min: 1, max: 200 },
    minCorr: { min: 0.02, max: 0.95 },
    entryWindowMs: { min: 250, max: 15000 },
    cooldownSec: { min: 0, max: 600 },
    edgeMult: { min: 0.5, max: 5 },
    confirmZ: { min: 0.2, max: 5 },
    riskQtyMultiplier: { min: 0.1, max: 5 },
  };
}

function defaultParams() {
  return {
    impulseZ: 2,
    minSamples: 200,
    minImpulses: 5,
    minCorr: 0.12,
    entryWindowMs: 3000,
    cooldownSec: 15,
    edgeMult: 1,
    confirmZ: 1,
    riskQtyMultiplier: 1,
  };
}

function defaultPreset(name = "Default preset") {
  return {
    id: crypto.randomUUID(),
    name,
    shortlistMax: 10,
    excludedCoins: [],
    params: defaultParams(),
    bounds: defaultBounds(),
    stats: { pnlUsdt: 0, roiPct: 0, trades: 0, winRate: 0 },
    updatedAt: now(),
    isSessionClone: false,
    sourcePresetId: null,
  };
}

function sanitizeExcluded(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      symbol: String(r?.symbol || "").trim().toUpperCase(),
      source: ["ANY", "BT", "BNB"].includes(String(r?.source || "ANY").toUpperCase()) ? String(r?.source || "ANY").toUpperCase() : "ANY",
      reason: String(r?.reason || "").trim(),
      attempts: Math.max(0, Math.trunc(clampNum(r?.attempts, 0))),
      updatedAt: clampNum(r?.updatedAt, now()),
    }))
    .filter((r) => Boolean(r.symbol));
}

function normalizeParams(input, fallbackParams) {
  const params = {};
  for (const key of PARAM_KEYS) {
    const fromFlat = input?.[key];
    const fromNested = input?.params?.[key];
    params[key] = clampNum(fromNested ?? fromFlat, fallbackParams[key]);
  }
  params.minSamples = Math.max(2, Math.trunc(params.minSamples));
  params.minImpulses = Math.max(1, Math.trunc(params.minImpulses));
  params.entryWindowMs = Math.max(250, Math.trunc(params.entryWindowMs));
  params.cooldownSec = Math.max(0, Math.trunc(params.cooldownSec));
  return params;
}

function normalizeBounds(input, fallbackBounds) {
  const out = {};
  for (const key of PARAM_KEYS) {
    const b = input?.bounds?.[key] || fallbackBounds[key] || { min: -Infinity, max: Infinity };
    let min = clampNum(b?.min, fallbackBounds[key]?.min);
    let max = clampNum(b?.max, fallbackBounds[key]?.max);
    if (max < min) [min, max] = [max, min];
    out[key] = { min, max };
  }
  return out;
}

function applyBounds(params, bounds) {
  const next = { ...params };
  for (const key of PARAM_KEYS) {
    const min = clampNum(bounds?.[key]?.min, -Infinity);
    const max = clampNum(bounds?.[key]?.max, Infinity);
    next[key] = Math.max(min, Math.min(max, next[key]));
  }
  next.minSamples = Math.max(2, Math.trunc(next.minSamples));
  next.minImpulses = Math.max(1, Math.trunc(next.minImpulses));
  next.entryWindowMs = Math.max(250, Math.trunc(next.entryWindowMs));
  next.cooldownSec = Math.max(0, Math.trunc(next.cooldownSec));
  return next;
}

function sanitizePreset(input, fallback = defaultPreset()) {
  const safe = { ...fallback, ...(input && typeof input === "object" ? input : {}) };
  safe.id = String(safe.id || crypto.randomUUID());
  safe.name = String(safe.name || "Preset").trim() || "Preset";
  safe.shortlistMax = Math.min(300, Math.max(1, Math.trunc(clampNum(safe.shortlistMax, 10))));
  safe.excludedCoins = sanitizeExcluded(safe.excludedCoins);
  safe.bounds = normalizeBounds(safe, fallback.bounds);
  safe.params = applyBounds(normalizeParams(safe, fallback.params), safe.bounds);
  safe.stats = {
    pnlUsdt: clampNum(safe?.stats?.pnlUsdt, 0),
    roiPct: clampNum(safe?.stats?.roiPct, 0),
    trades: Math.max(0, Math.trunc(clampNum(safe?.stats?.trades, 0))),
    winRate: clampNum(safe?.stats?.winRate, 0),
  };
  safe.updatedAt = clampNum(safe.updatedAt, now());
  safe.isSessionClone = Boolean(safe.isSessionClone);
  safe.sourcePresetId = safe.sourcePresetId ? String(safe.sourcePresetId) : null;
  return safe;
}

export function createPresetsStore({ filePath = DEFAULT_PATH, logger = console } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let state = { activePresetId: null, presets: [] };

  function persist() {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }

  function ensureDefaults() {
    if (!state.presets.length) {
      const p = defaultPreset();
      state = { activePresetId: p.id, presets: [p] };
      persist();
    }
    if (!state.activePresetId || !state.presets.some((p) => p.id === state.activePresetId)) {
      state.activePresetId = state.presets[0]?.id || null;
      persist();
    }
  }

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
        state = {
          activePresetId: raw?.activePresetId || null,
          presets: Array.isArray(raw?.presets) ? raw.presets.map((p) => sanitizePreset(p)) : [],
        };
      }
    } catch (e) {
      logger?.warn?.({ err: e }, "failed loading presets store");
      state = { activePresetId: null, presets: [] };
    }
    ensureDefaults();
  }

  function getState() {
    return {
      activePresetId: state.activePresetId,
      presets: state.presets.map((p) => ({ ...p, params: { ...p.params }, bounds: JSON.parse(JSON.stringify(p.bounds)), excludedCoins: p.excludedCoins.map((x) => ({ ...x })) })),
    };
  }

  function getPresetById(id) {
    return state.presets.find((p) => p.id === id) || null;
  }

  function getActivePreset() {
    return getPresetById(state.activePresetId) || null;
  }

  function createPreset(payload = {}) {
    const base = defaultPreset(String(payload?.name || "Preset"));
    const p = sanitizePreset({ ...base, ...payload, id: crypto.randomUUID(), updatedAt: now(), isSessionClone: false, sourcePresetId: null }, base);
    state.presets.unshift(p);
    persist();
    return p;
  }

  function updatePreset(id, payload = {}) {
    const idx = state.presets.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const prev = state.presets[idx];
    const next = sanitizePreset({ ...prev, ...payload, id: prev.id, updatedAt: now() }, prev);
    state.presets[idx] = next;
    persist();
    return next;
  }

  function deletePreset(id) {
    const idx = state.presets.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    state.presets.splice(idx, 1);
    ensureDefaults();
    persist();
    return true;
  }

  function selectPreset(id) {
    if (!getPresetById(id)) return false;
    state.activePresetId = id;
    persist();
    return true;
  }

  function clonePresetAsSession(id) {
    const source = getPresetById(id);
    if (!source) return null;
    const copy = sanitizePreset({
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} (session)`,
      updatedAt: now(),
      isSessionClone: true,
      sourcePresetId: source.id,
    }, source);
    state.presets.unshift(copy);
    persist();
    return copy;
  }

  function upsertStats(id, stats = {}) {
    const p = getPresetById(id);
    if (!p) return null;
    p.stats = {
      pnlUsdt: clampNum(stats.pnlUsdt, p.stats.pnlUsdt),
      roiPct: clampNum(stats.roiPct, p.stats.roiPct),
      trades: Math.max(0, Math.trunc(clampNum(stats.trades, p.stats.trades))),
      winRate: clampNum(stats.winRate, p.stats.winRate),
    };
    p.updatedAt = now();
    persist();
    return p;
  }

  load();

  return {
    getState,
    getPresetById,
    getActivePreset,
    createPreset,
    updatePreset,
    deletePreset,
    selectPreset,
    clonePresetAsSession,
    upsertStats,
  };
}

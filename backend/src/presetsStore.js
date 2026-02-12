import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_PATH = path.resolve(process.cwd(), "backend/data/presets.json");

function now() {
  return Date.now();
}

function clampNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function defaultPreset(name = "Default preset") {
  return {
    id: crypto.randomUUID(),
    name,
    shortlistMax: 10,
    excludedCoins: [],
    impulseZ: 2,
    confirmZ: 1,
    minCorr: 0.12,
    edgeMult: 1,
    riskImpulseMargin: 0.001,
    riskQtyMultiplier: 1,
    cooldownSec: 15,
    bounds: {
      impulseZ: { min: 1, max: 4 },
      minCorr: { min: 0.02, max: 0.9 },
      edgeMult: { min: 0.5, max: 3 },
      confirmZ: { min: 0.5, max: 3 },
      riskQtyMultiplier: { min: 0.2, max: 3 },
    },
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

function sanitizePreset(input, fallback = defaultPreset()) {
  const safe = { ...fallback, ...(input && typeof input === "object" ? input : {}) };
  safe.id = String(safe.id || crypto.randomUUID());
  safe.name = String(safe.name || "Preset").trim() || "Preset";
  safe.shortlistMax = Math.min(10, Math.max(1, Math.trunc(clampNum(safe.shortlistMax, 10))));
  safe.excludedCoins = sanitizeExcluded(safe.excludedCoins);
  safe.impulseZ = clampNum(safe.impulseZ, fallback.impulseZ);
  safe.confirmZ = clampNum(safe.confirmZ, fallback.confirmZ);
  safe.minCorr = clampNum(safe.minCorr, fallback.minCorr);
  safe.edgeMult = clampNum(safe.edgeMult, fallback.edgeMult);
  safe.riskImpulseMargin = clampNum(safe.riskImpulseMargin, fallback.riskImpulseMargin);
  safe.riskQtyMultiplier = clampNum(safe.riskQtyMultiplier, fallback.riskQtyMultiplier);
  safe.cooldownSec = Math.max(0, Math.trunc(clampNum(safe.cooldownSec, fallback.cooldownSec)));
  safe.bounds = {
    impulseZ: {
      min: clampNum(safe?.bounds?.impulseZ?.min, fallback.bounds.impulseZ.min),
      max: clampNum(safe?.bounds?.impulseZ?.max, fallback.bounds.impulseZ.max),
    },
    minCorr: {
      min: clampNum(safe?.bounds?.minCorr?.min, fallback.bounds.minCorr.min),
      max: clampNum(safe?.bounds?.minCorr?.max, fallback.bounds.minCorr.max),
    },
    edgeMult: {
      min: clampNum(safe?.bounds?.edgeMult?.min, fallback.bounds.edgeMult.min),
      max: clampNum(safe?.bounds?.edgeMult?.max, fallback.bounds.edgeMult.max),
    },
    confirmZ: {
      min: clampNum(safe?.bounds?.confirmZ?.min, fallback.bounds.confirmZ.min),
      max: clampNum(safe?.bounds?.confirmZ?.max, fallback.bounds.confirmZ.max),
    },
    riskQtyMultiplier: {
      min: clampNum(safe?.bounds?.riskQtyMultiplier?.min, fallback.bounds.riskQtyMultiplier.min),
      max: clampNum(safe?.bounds?.riskQtyMultiplier?.max, fallback.bounds.riskQtyMultiplier.max),
    },
  };
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
      presets: state.presets.map((p) => ({ ...p, excludedCoins: p.excludedCoins.map((x) => ({ ...x })) })),
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

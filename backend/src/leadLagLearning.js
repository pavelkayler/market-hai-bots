import fs from 'node:fs';
import path from 'node:path';

const GRID = [0.05, 0.1, 0.15, 0.2];

function configKey(p) { return `${p.thresholdPct}|${p.slPct}|${p.tpPct}`; }

function nowMs() { return Date.now(); }

function clampGrid(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return GRID[1];
  let best = GRID[0];
  let dist = Math.abs(n - best);
  for (const g of GRID) {
    const d = Math.abs(g - n);
    if (d < dist) { dist = d; best = g; }
  }
  return best;
}

export function createLeadLagLearning({ filePath, onState } = {}) {
  const absPath = filePath || path.resolve('backend/data/leadlag_episodes.jsonl');
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const state = {
    episodesCount: 0,
    lastEpisodeTs: null,
    autoEnabled: false,
    activeParams: { thresholdPct: 0.1, slPct: 0.1, tpPct: 0.1 },
    aggregates: new Map(),
    queue: [],
    flushing: false,
    tradeRatePerHour: 0,
    lastRateTickAt: nowMs(),
    rateCount: 0,
    lastChange: null,
    baseline: null,
    cooldownTrades: 20,
    sinceChangeTrades: 0,
  };

  function emit() {
    onState?.(getState());
  }

  async function flush() {
    if (state.flushing || !state.queue.length) return;
    state.flushing = true;
    const chunk = state.queue.splice(0, 100);
    const body = `${chunk.map((x) => JSON.stringify(x)).join('\n')}\n`;
    try { await fs.promises.appendFile(absPath, body, 'utf8'); } catch {}
    state.flushing = false;
    if (state.queue.length) setTimeout(flush, 0);
  }

  function addAggregate(params, pnl, win) {
    const key = configKey(params);
    const prev = state.aggregates.get(key) || { key, params, trades: 0, wins: 0, pnlSum: 0 };
    prev.trades += 1;
    if (win) prev.wins += 1;
    prev.pnlSum += Number(pnl || 0);
    state.aggregates.set(key, prev);
  }

  function getNeighbors() {
    const cur = state.activeParams;
    const arr = [];
    for (const dim of ['thresholdPct', 'slPct', 'tpPct']) {
      for (const g of GRID) {
        if (cur[dim] === g) continue;
        arr.push({ ...cur, [dim]: g, changed: dim });
      }
    }
    return arr;
  }

  function scoreConfig(cfg) {
    const key = configKey(cfg);
    const row = state.aggregates.get(key) || { trades: 0, wins: 0, pnlSum: 0 };
    const totalTrades = Math.max(1, Array.from(state.aggregates.values()).reduce((a, b) => a + b.trades, 0));
    const mean = row.trades ? (row.pnlSum / row.trades) : 0;
    const bonus = Math.sqrt((2 * Math.log(totalTrades)) / Math.max(1, row.trades));
    return mean + bonus;
  }

  function maybeTune() {
    if (!state.autoEnabled) return;
    if (state.sinceChangeTrades < state.cooldownTrades) return;

    const neighbors = getNeighbors();
    if (!neighbors.length) return;
    neighbors.sort((a, b) => scoreConfig(b) - scoreConfig(a));
    const best = neighbors[0];
    const old = { ...state.activeParams };
    state.activeParams = { thresholdPct: best.thresholdPct, slPct: best.slPct, tpPct: best.tpPct };
    state.lastChange = { ts: nowMs(), reason: `UCB best neighbor (${best.changed})`, from: old, to: state.activeParams };
    state.baseline = { params: old, mean: scoreConfig(old), tradesAtChange: state.episodesCount };
    state.sinceChangeTrades = 0;
  }

  function maybeRollback() {
    if (!state.baseline) return;
    const tradesSince = state.episodesCount - state.baseline.tradesAtChange;
    if (tradesSince < 8) return;
    const currentMean = scoreConfig(state.activeParams);
    if (currentMean < state.baseline.mean) {
      const from = { ...state.activeParams };
      state.activeParams = { ...state.baseline.params };
      state.lastChange = { ts: nowMs(), reason: 'rollback after underperformance', from, to: state.activeParams };
    }
    state.baseline = null;
  }

  function onEpisode(episode = {}) {
    state.episodesCount += 1;
    state.lastEpisodeTs = Number(episode.ts || nowMs());
    state.queue.push(episode);
    flush();

    const params = {
      thresholdPct: clampGrid(episode?.params?.thresholdPct),
      slPct: clampGrid(episode?.params?.slPct),
      tpPct: clampGrid(episode?.params?.tpPct),
    };
    const win = Boolean(episode?.outcome?.win);
    addAggregate(params, episode?.pnlUSDT, win);

    state.rateCount += 1;
    const elapsedH = Math.max(1 / 3600, (nowMs() - state.lastRateTickAt) / 3600000);
    if (elapsedH >= 0.2) {
      const instantRate = state.rateCount / elapsedH;
      state.tradeRatePerHour = state.tradeRatePerHour > 0 ? ((state.tradeRatePerHour * 0.8) + (instantRate * 0.2)) : instantRate;
      state.rateCount = 0;
      state.lastRateTickAt = nowMs();
    }
    state.sinceChangeTrades += 1;
    maybeRollback();
    maybeTune();
    emit();
  }

  function getState() {
    const targetTrades = 200;
    const etaLearningSec = state.tradeRatePerHour > 0
      ? Math.max(0, Math.round(((targetTrades - state.episodesCount) / state.tradeRatePerHour) * 3600))
      : null;
    const topConfigs = Array.from(state.aggregates.values())
      .map((r) => ({
        ...r,
        winrate: r.trades ? (r.wins / r.trades) * 100 : 0,
        avgPnl: r.trades ? (r.pnlSum / r.trades) : 0,
      }))
      .sort((a, b) => b.pnlSum - a.pnlSum)
      .slice(0, 5);
    return {
      episodesCount: state.episodesCount,
      lastEpisodeTs: state.lastEpisodeTs,
      activeParams: state.activeParams,
      autoEnabled: state.autoEnabled,
      etaLearningSec,
      lastChange: state.lastChange,
      topConfigs,
    };
  }

  function setAuto(enabled) {
    state.autoEnabled = Boolean(enabled);
    emit();
    return getState();
  }

  async function syncNow() {
    try {
      const raw = await fs.promises.readFile(absPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      state.aggregates.clear();
      state.episodesCount = 0;
      for (const line of lines) {
        let parsed = null;
        try { parsed = JSON.parse(line); } catch {}
        if (!parsed) continue;
        state.episodesCount += 1;
        const params = {
          thresholdPct: clampGrid(parsed?.params?.thresholdPct),
          slPct: clampGrid(parsed?.params?.slPct),
          tpPct: clampGrid(parsed?.params?.tpPct),
        };
        addAggregate(params, parsed?.pnlUSDT, Boolean(parsed?.outcome?.win));
        state.lastEpisodeTs = Number(parsed?.ts || state.lastEpisodeTs || 0) || state.lastEpisodeTs;
      }
    } catch {}
    emit();
    return getState();
  }

  return { onEpisode, getState, setAuto, syncNow, getActiveParams: () => ({ ...state.activeParams }) };
}

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

const DEFAULTS = {
  maxWaitFirstTickSec: 60,
  maxWaitSecondTickSec: 10,
  subscribeChunkSize: 50,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function nowIso() { return new Date().toISOString(); }

export function createUniverseSearchService({ marketData, subscriptions, bybitRest, logger = console, persistPath = 'backend/data/universe_search_latest.json', emitState = () => {}, emitResult = () => {} } = {}) {
  const emitter = new EventEmitter();
  let state = {
    phase: 'IDLE',
    status: 'IDLE',
    latestResult: null,
  };
  let run = null;
  let latestResult = null;

  async function ensureLoaded() {
    try {
      const raw = await fs.readFile(persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      latestResult = parsed;
      state.latestResult = latestResult;
    } catch {}
  }

  async function persistLatest() {
    if (!latestResult) return;
    await fs.mkdir(path.dirname(persistPath), { recursive: true });
    await fs.writeFile(persistPath, JSON.stringify(latestResult, null, 2));
  }

  function emitStateTick() {
    const payload = getState();
    emitter.emit('state', payload);
    emitState(payload);
  }

  function setPhase(next, patch = {}) {
    state = { ...state, phase: next, status: next, ...patch };
    emitStateTick();
  }

  function getState() {
    const elapsedSec = run?.startedAt ? Math.round((Date.now() - run.startedAt) / 1000) : 0;
    const counters = run?.result?.counters || latestResult?.counters || {};
    return {
      searchId: run?.result?.searchId || latestResult?.searchId || null,
      status: state.status,
      phase: state.phase,
      elapsedSec,
      progress: {
        phase: state.phase,
        elapsedSec,
      },
      counters,
      latestResultSummary: latestResult ? {
        searchId: latestResult.searchId,
        startedAt: latestResult.startedAt,
        endedAt: latestResult.endedAt,
        status: latestResult.status,
        fastCount: latestResult.outputs?.fastUniverseSymbols?.length || 0,
        slowCount: latestResult.outputs?.slowUniverseSymbols?.length || 0,
      } : null,
    };
  }

  function onTicker(tick) {
    if (!run || run.stopping) return;
    const symbol = String(tick?.symbol || '').toUpperCase();
    const row = run.stats.get(symbol);
    if (!row) return;
    const ts = Number(tick?.ts || Date.now());
    row.lastTickAt = ts;
    if (run.phase === 'PHASE_A_EXISTS') {
      if (!row.firstTickAt) {
        row.firstTickAt = ts;
        row.status = 'EXISTS';
        run.existsPool.push(symbol);
      }
      return;
    }
    if (run.phase !== 'PHASE_B_SPEED') return;
    if (!run.phaseBSymbols.has(symbol)) return;
    if (!row.phaseBFirstTickAt) {
      row.phaseBFirstTickAt = ts;
      row.status = 'EXISTS';
      return;
    }
    if (!row.phaseBSecondTickAt) {
      row.phaseBSecondTickAt = ts;
      row.secondTickDeltaMs = Math.max(0, ts - row.phaseBFirstTickAt);
      row.status = 'FAST_SECOND_TICK';
    }
  }

  function buildEmptyResult(config) {
    return {
      searchId: `usearch_${Date.now()}`,
      startedAt: nowIso(),
      endedAt: null,
      status: 'STARTING',
      config,
      counters: {
        candidatesTotal: 0,
        firstTickReceivedCount: 0,
        timedOutNoFirstTickCount: 0,
        secondTickOkCount: 0,
        secondTickMissingCount: 0,
      },
      perSymbolStats: [],
      outputs: {
        existsAllSymbols: [],
        fastUniverseSymbols: [],
        slowUniverseSymbols: [],
      },
      progress: { phase: 'STARTING', elapsedSec: 0, etaSec: null },
    };
  }

  async function start({ targetSizeN }) {
    const n = Number(targetSizeN);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'INVALID_TARGET_SIZE' };
    if (run) return { ok: false, error: 'SEARCH_ALREADY_RUNNING' };

    const config = { targetSizeN: n, ...DEFAULTS };
    run = {
      stopping: false,
      phase: 'STARTING',
      startedAt: Date.now(),
      stats: new Map(),
      existsPool: [],
      activeSymbols: new Set(),
      phaseBSymbols: new Set(),
      result: buildEmptyResult(config),
    };
    setPhase('STARTING');

    try {
      const list = await bybitRest.getInstrumentsLinearAll();
      const candidates = list
        .filter((x) => String(x?.status || '').toUpperCase() === 'TRADING' && String(x?.symbol || '').endsWith('USDT') && String(x?.contractType || '').includes('LinearPerpetual'))
        .map((x) => String(x.symbol).toUpperCase());
      run.result.counters.candidatesTotal = candidates.length;
      for (const s of candidates) run.stats.set(s, { symbol: s, firstTickAt: null, secondTickAt: null, secondTickDeltaMs: null, status: 'NO_FIRST_TICK_TIMEOUT' });

      setPhase('PHASE_A_EXISTS');
      run.phase = 'PHASE_A_EXISTS';
      const phaseADeadline = Date.now() + (config.maxWaitFirstTickSec * 1000);
      for (let i = 0; i < candidates.length && Date.now() < phaseADeadline && !run.stopping; i += config.subscribeChunkSize) {
        const chunk = candidates.slice(i, i + config.subscribeChunkSize);
        for (const sym of chunk) run.activeSymbols.add(sym);
        subscriptions.requestFeed('universe-search', { bybitSymbols: [...run.activeSymbols], streams: ['ticker'] });
        await sleep(500);
      }
      while (!run.stopping && Date.now() < phaseADeadline) {
        const enough = run.existsPool.length >= (config.targetSizeN * 3);
        if (enough) break;
        await sleep(200);
      }
      subscriptions.releaseFeed('universe-search');
      run.activeSymbols.clear();

      const existsOrdered = [...run.existsPool].sort((a, b) => Number(run.stats.get(a)?.firstTickAt || 0) - Number(run.stats.get(b)?.firstTickAt || 0));
      for (const s of existsOrdered) run.stats.get(s).status = 'EXISTS';
      run.result.counters.firstTickReceivedCount = existsOrdered.length;
      run.result.counters.timedOutNoFirstTickCount = Math.max(0, candidates.length - existsOrdered.length);
      run.result.outputs.existsAllSymbols = existsOrdered;

      if (run.stopping) throw new Error('STOPPED');

      setPhase('PHASE_B_SPEED');
      run.phase = 'PHASE_B_SPEED';
      for (const sym of existsOrdered) {
        const row = run.stats.get(sym);
        row.phaseBFirstTickAt = null;
        row.phaseBSecondTickAt = null;
        row.secondTickDeltaMs = null;
      }
      const phaseBSymbols = existsOrdered.slice(0, Math.max(config.targetSizeN * 4, config.targetSizeN));
      run.phaseBSymbols = new Set(phaseBSymbols);
      subscriptions.requestFeed('universe-search', { bybitSymbols: phaseBSymbols, streams: ['ticker'] });
      const bDeadline = Date.now() + (config.maxWaitSecondTickSec * 1000);
      while (!run.stopping && Date.now() < bDeadline) await sleep(200);
      subscriptions.releaseFeed('universe-search');

      const fast = [];
      const slowMissingSecond = [];
      const slowWithDelta = [];
      for (const sym of existsOrdered) {
        const row = run.stats.get(sym);
        if (row.phaseBSecondTickAt && Number.isFinite(row.secondTickDeltaMs)) {
          row.status = 'FAST_SECOND_TICK';
          fast.push(sym);
          continue;
        }
        if (row.phaseBFirstTickAt) {
          row.status = 'SLOW_NO_SECOND_TICK';
          slowMissingSecond.push(sym);
          continue;
        }
        row.status = 'SLOW_NO_SECOND_TICK';
        slowWithDelta.push(sym);
      }
      fast.sort((a, b) => Number(run.stats.get(a)?.secondTickDeltaMs || Infinity) - Number(run.stats.get(b)?.secondTickDeltaMs || Infinity));
      const fastUniverseSymbols = fast.slice(0, config.targetSizeN);
      const remaining = existsOrdered.filter((s) => !fastUniverseSymbols.includes(s));
      const slowOrdered = [...remaining.filter((s) => slowMissingSecond.includes(s)), ...remaining.filter((s) => !slowMissingSecond.includes(s))];
      const slowUniverseSymbols = slowOrdered.slice(0, config.targetSizeN);

      run.result.counters.secondTickOkCount = fast.length;
      run.result.counters.secondTickMissingCount = Math.max(0, existsOrdered.length - fast.length);
      run.result.outputs.fastUniverseSymbols = fastUniverseSymbols;
      run.result.outputs.slowUniverseSymbols = slowUniverseSymbols;
      run.result.perSymbolStats = existsOrdered.map((s) => {
        const row = run.stats.get(s);
        return {
          symbol: s,
          firstTickAt: row.firstTickAt,
          secondTickAt: row.phaseBSecondTickAt || null,
          secondTickDeltaMs: row.secondTickDeltaMs,
          status: row.status,
        };
      });

      run.result.status = 'FINISHED';
      run.result.endedAt = nowIso();
      latestResult = run.result;
      state.latestResult = latestResult;
      await persistLatest();
      setPhase('FINISHED');
      emitResult(latestResult);
      run = null;
      return { ok: true, result: latestResult };
    } catch (err) {
      subscriptions.releaseFeed('universe-search');
      const stopped = String(err?.message || '') === 'STOPPED' || run?.stopping;
      if (run?.result) {
        run.result.status = stopped ? 'STOPPED' : 'ERROR';
        run.result.endedAt = nowIso();
        latestResult = run.result;
        state.latestResult = latestResult;
        await persistLatest().catch(() => {});
      }
      setPhase(stopped ? 'IDLE' : 'ERROR');
      run = null;
      return { ok: false, error: stopped ? 'STOPPED' : 'SEARCH_FAILED', message: String(err?.message || err) };
    }
  }

  function stop() {
    if (!run) return { ok: false, error: 'NOT_RUNNING' };
    run.stopping = true;
    subscriptions.releaseFeed('universe-search');
    setPhase('STOPPING');
    return { ok: true };
  }

  function getLatestResult() { return latestResult; }

  marketData.onTickerTick?.(onTicker);
  ensureLoaded().catch(() => {});

  return {
    start,
    stop,
    getState,
    getLatestResult,
    onState: (fn) => emitter.on('state', fn),
  };
}

const STATUS = {
  ACTIVE: 0,
  DROPPED: 1,
  QUALIFIED: 2,
  PAUSED: 3,
};

const STATUS_LABEL = ['active', 'dropped', 'qualified', 'paused'];

function clampInt(v, min, max) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function meanStd(values = []) {
  if (!values.length) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let acc = 0;
  for (const v of values) {
    const d = v - mean;
    acc += d * d;
  }
  return { mean, std: Math.sqrt(acc / Math.max(1, values.length - 1)) };
}

function ewma(prev, next, alpha = 0.2) {
  if (!Number.isFinite(prev) || prev <= 0) return next;
  return (prev * (1 - alpha)) + (next * alpha);
}

export function createLeadLagSearchV2({ getUniverseSymbols, getBars, onState, onShortlist, onLog } = {}) {
  let runner = null;
  let state = { running: false, phase: 'IDLE', progress: { totalPairs: 0, processedPairs: 0, activePairs: 0, droppedPairs: 0, qualifiedPairs: 0 }, etaScanSec: null };

  function emitState() {
    onState?.(getState());
  }

  function emitShortlist() {
    onShortlist?.(getShortlist());
  }

  function pairCount(poolSize) {
    return poolSize * Math.max(0, poolSize - 1);
  }

  function decodePair(k, n) {
    const i = Math.floor(k / (n - 1));
    let j = k % (n - 1);
    if (j >= i) j += 1;
    return [i, j];
  }

  function encodePair(i, j, n) {
    return (i * (n - 1)) + (j > i ? j - 1 : j);
  }

  function buildFeature(symbol, impulseZ = 1.5) {
    const bars = getBars?.(symbol, 280, 'BT') || [];
    if (bars.length < 4) return { threshold: Infinity, retByTs: new Map(), latestTs: 0 };
    const sorted = [...bars].sort((a, b) => Number(a.ts || a.t || 0) - Number(b.ts || b.t || 0));
    const retByTs = new Map();
    const rets = [];
    let prev = null;
    for (const b of sorted) {
      const ts = Number(b.ts || b.t || 0);
      const c = Number(b.c);
      if (!Number.isFinite(ts) || !Number.isFinite(c) || c <= 0) continue;
      if (prev !== null) {
        const r = Math.log(c / prev);
        retByTs.set(ts, r);
        rets.push(r);
      }
      prev = c;
    }
    const { std } = meanStd(rets);
    const floor = 0.00005;
    return {
      threshold: Math.max((Number(impulseZ) || 1.5) * Math.max(std, floor), floor),
      retByTs,
      latestTs: Number(sorted[sorted.length - 1]?.ts || sorted[sorted.length - 1]?.t || 0),
    };
  }

  function start(params = {}) {
    if (runner?.running) return { ok: false, reason: 'ALREADY_RUNNING' };
    const poolSize = clampInt(params.poolSize || 50, 10, 200);
    const symbols = (getUniverseSymbols?.() || []).slice(0, poolSize);
    if (symbols.length < 3) return { ok: false, reason: 'UNIVERSE_EMPTY' };
    const N = symbols.length;
    const totalPairs = pairCount(N);
    runner = {
      running: true,
      params: {
        poolSize: N,
        lagsMs: Array.isArray(params.lagsMs) && params.lagsMs.length ? params.lagsMs : [250, 500, 750, 1000],
        responseWindowMs: clampInt(params.responseWindowMs || 1000, 250, 5000),
        followerThrMult: Number(params.followerThrMult || 0.5),
        followerAbsFloor: Number(params.followerAbsFloor || 0.00005),
        impulseZ: Number(params.impulseZ || 1.5),
        timeBudgetMs: clampInt(params.timeBudgetMs || 12, 4, 25),
      },
      symbols,
      attempts: new Uint16Array(totalPairs),
      failStreak: new Uint8Array(totalPairs),
      status: new Uint8Array(totalPairs),
      lastUpdateMs: new Float64Array(totalPairs),
      processedPairs: 0,
      droppedPairs: 0,
      qualifiedPairs: 0,
      activePairs: totalPairs,
      initIndex: 0,
      candidates: new Map(),
      lastProcessedImpulseTs: new Array(N).fill(0),
      followerCursor: new Array(N).fill(0),
      featureCache: new Array(N).fill(null),
      featureBuiltAt: 0,
      shortlistCache: [],
      evalsPerSec: 0,
      evalCounter: 0,
      evalWindowStartedAt: Date.now(),
      timer: null,
      phase: 'ENUMERATING',
      startedAt: Date.now(),
      touchedPairs: new Set(),
    };

    state = {
      running: true,
      phase: 'ENUMERATING',
      poolSize: N,
      params: runner.params,
      progress: { totalPairs, processedPairs: 0, activePairs: totalPairs, droppedPairs: 0, qualifiedPairs: 0 },
      etaScanSec: null,
      etaLearningSec: null,
      startedAt: runner.startedAt,
      updatedAtMs: Date.now(),
      message: 'enumerating pairs',
    };

    const tick = () => {
      if (!runner?.running) return;
      const tickStart = Date.now();
      while (Date.now() - tickStart < runner.params.timeBudgetMs) {
        if (runner.phase === 'ENUMERATING') {
          if (runner.initIndex >= totalPairs) {
            runner.phase = 'TRACKING';
            state.phase = 'TRACKING';
            state.message = 'tracking impulses';
            continue;
          }
          const step = Math.min(1500, totalPairs - runner.initIndex);
          runner.initIndex += step;
          runner.processedPairs = runner.initIndex;
          state.progress.processedPairs = runner.processedPairs;
          const remained = totalPairs - runner.processedPairs;
          const elapsed = Math.max(1, (Date.now() - runner.startedAt) / 1000);
          const rate = runner.processedPairs / elapsed;
          state.etaScanSec = rate > 0 ? Math.round(remained / rate) : null;
          continue;
        }

        if ((Date.now() - runner.featureBuiltAt) > 5000) {
          for (let i = 0; i < runner.symbols.length; i += 1) runner.featureCache[i] = buildFeature(runner.symbols[i], runner.params.impulseZ);
          runner.featureBuiltAt = Date.now();
        }

        for (let li = 0; li < runner.symbols.length; li += 1) {
          const leaderFeature = runner.featureCache[li];
          if (!leaderFeature) continue;
          const newImpulseTs = [];
          for (const [ts, r] of leaderFeature.retByTs.entries()) {
            if (ts <= runner.lastProcessedImpulseTs[li]) continue;
            if (Math.abs(r) >= leaderFeature.threshold) newImpulseTs.push([ts, r]);
          }
          if (!newImpulseTs.length) continue;
          newImpulseTs.sort((a, b) => a[0] - b[0]);
          for (const [signalTs, leaderRet] of newImpulseTs.slice(0, 2)) {
            const direction = Math.sign(leaderRet);
            const maxFollowers = 30;
            let checked = 0;
            let cur = runner.followerCursor[li];
            while (checked < maxFollowers) {
              const fj = cur % runner.symbols.length;
              cur += 1;
              if (fj === li) continue;
              const pIdx = encodePair(li, fj, runner.symbols.length);
              if (runner.status[pIdx] === STATUS.DROPPED) continue;
              checked += 1;
              const followerFeature = runner.featureCache[fj];
              if (!followerFeature) continue;

              runner.attempts[pIdx] = Math.min(65535, runner.attempts[pIdx] + 1);
              const lag = runner.params.lagsMs[0] || 250;
              let followerResp = 0;
              for (const [fTs, fRet] of followerFeature.retByTs.entries()) {
                if (fTs < signalTs + lag) continue;
                if (fTs > signalTs + lag + runner.params.responseWindowMs) break;
                followerResp += fRet;
              }
              const followerThr = Math.max(runner.params.followerThrMult * followerFeature.threshold, runner.params.followerAbsFloor);
              const ok = Math.sign(followerResp) === direction && Math.abs(followerResp) >= followerThr;
              if (ok) runner.failStreak[pIdx] = 0;
              else {
                runner.failStreak[pIdx] = Math.min(255, runner.failStreak[pIdx] + 1);
                if (runner.failStreak[pIdx] >= 10) {
                  if (runner.status[pIdx] !== STATUS.DROPPED) {
                    runner.status[pIdx] = STATUS.DROPPED;
                    runner.droppedPairs += 1;
                    runner.activePairs = Math.max(0, totalPairs - runner.droppedPairs);
                  }
                }
              }
              runner.lastUpdateMs[pIdx] = Date.now();
              const c = runner.candidates.get(pIdx) || { confirmations: 0, nonConfirmations: 0, lastSignalTime: 0 };
              if (ok) c.confirmations += 1; else c.nonConfirmations += 1;
              c.lastSignalTime = signalTs;
              const samples = c.confirmations + c.nonConfirmations;
              if (c.confirmations > 0 || samples >= 3) runner.candidates.set(pIdx, c);
              if (samples >= 10 && runner.status[pIdx] === STATUS.ACTIVE) {
                runner.status[pIdx] = STATUS.QUALIFIED;
              }
              runner.touchedPairs.add(pIdx);
              runner.evalCounter += 1;
            }
            runner.followerCursor[li] = cur;
            runner.lastProcessedImpulseTs[li] = signalTs;
          }
        }

        const elapsedEvalSec = Math.max(1, (Date.now() - runner.evalWindowStartedAt) / 1000);
        if (elapsedEvalSec >= 1) {
          const instRate = runner.evalCounter / elapsedEvalSec;
          runner.evalsPerSec = ewma(runner.evalsPerSec, instRate, 0.2);
          runner.evalCounter = 0;
          runner.evalWindowStartedAt = Date.now();
        }

        const top = Array.from(runner.candidates.entries()).map(([pairIndex, c]) => {
          const [li, fj] = decodePair(pairIndex, runner.symbols.length);
          const samples = c.confirmations + c.nonConfirmations;
          const loyalty = samples > 0 ? (c.confirmations / samples) : 0;
          const ageSec = Math.max(0, (Date.now() - Number(c.lastSignalTime || 0)) / 1000);
          const recent = Math.exp(-ageSec / 600);
          const rankScore = 100 * loyalty * Math.log(1 + samples) * recent;
          return {
            pairIndex,
            leader: runner.symbols[li],
            follower: runner.symbols[fj],
            confirmations: c.confirmations,
            nonConfirmations: c.nonConfirmations,
            loyaltyPct: loyalty * 100,
            samples,
            lastSignalTime: c.lastSignalTime,
            rankScore,
          };
        }).filter((r) => r.samples >= 10).sort((a, b) => b.rankScore - a.rankScore).slice(0, 10).map((r, idx) => ({ ...r, rank: idx + 1 }));
        runner.shortlistCache = top;

        const unTouched = Math.max(0, totalPairs - runner.touchedPairs.size);
        state = {
          ...state,
          running: true,
          phase: runner.phase,
          updatedAtMs: Date.now(),
          message: runner.phase === 'TRACKING' ? 'tracking impulses' : 'enumerating pairs',
          progress: {
            totalPairs,
            processedPairs: runner.processedPairs,
            activePairs: runner.activePairs,
            droppedPairs: runner.droppedPairs,
            qualifiedPairs: runner.qualifiedPairs,
          },
          etaScanSec: runner.evalsPerSec > 0 ? Math.round(unTouched / runner.evalsPerSec) : state.etaScanSec,
        };

        break;
      }
      emitState();
      emitShortlist();
      runner.timer = setTimeout(tick, 60);
    };

    runner.timer = setTimeout(tick, 0);
    emitState();
    onLog?.({ level: 'info', message: `LeadLag search v2 started N=${N}`, ts: Date.now() });
    return { ok: true };
  }

  function stop(reason = 'stopped') {
    if (runner?.timer) clearTimeout(runner.timer);
    if (runner) runner.running = false;
    runner = null;
    state = { ...state, running: false, phase: 'IDLE', message: reason, updatedAtMs: Date.now() };
    emitState();
    return { ok: true };
  }

  function getState() {
    return {
      phase: state.phase,
      running: Boolean(state.running),
      poolSize: Number(state.poolSize || 0),
      params: state.params || {},
      progress: state.progress || { totalPairs: 0, processedPairs: 0, activePairs: 0, droppedPairs: 0, qualifiedPairs: 0 },
      etaScanSec: Number.isFinite(state.etaScanSec) ? state.etaScanSec : null,
      etaLearningSec: Number.isFinite(state.etaLearningSec) ? state.etaLearningSec : null,
      message: state.message || 'idle',
      updatedAtMs: Number(state.updatedAtMs || Date.now()),
    };
  }

  function getShortlist() {
    const top = runner?.shortlistCache || [];
    return { ts: Date.now(), top };
  }

  function getCombosPage({ page = 1, pageSize = 200, filter = {} } = {}) {
    if (!runner) return { page: 1, pageSize, totalRows: 0, rows: [] };
    const pageN = clampInt(page, 1, 100000);
    const size = clampInt(pageSize, 20, 500);
    const statusFilter = String(filter?.status || '').toLowerCase();
    const q = String(filter?.q || '').trim().toUpperCase();
    const rows = [];
    for (let k = 0; k < runner.attempts.length; k += 1) {
      const statusText = STATUS_LABEL[runner.status[k]] || 'active';
      if (statusFilter && statusFilter !== 'all' && statusText !== statusFilter) continue;
      const [li, fj] = decodePair(k, runner.symbols.length);
      const leader = runner.symbols[li];
      const follower = runner.symbols[fj];
      if (q && !leader.includes(q) && !follower.includes(q)) continue;
      rows.push({
        pairIndex: k,
        leader,
        follower,
        attempts: Number(runner.attempts[k]),
        failStreak: Number(runner.failStreak[k]),
        status: statusText,
        lastUpdate: Number(runner.lastUpdateMs[k] || 0) || null,
      });
    }
    const totalRows = rows.length;
    const start = (pageN - 1) * size;
    const pageRows = rows.slice(start, start + size);
    return { page: pageN, pageSize: size, totalRows, rows: pageRows };
  }

  return { start, stop, getState, getShortlist, getCombosPage };
}

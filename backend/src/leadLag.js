// backend/src/leadLag.js
// Rolling lead-lag estimator on fixed-interval microbars.
// Output: top-N pairs with best lag + confirmation (samples/impulses).

function meanStd(values) {
  const n = values.length;
  if (n < 2) return { mean: 0, std: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    v += d * d;
  }
  const std = Math.sqrt(v / (n - 1));
  return { mean, std };
}

function pearsonFromSums(n, sumX, sumY, sumX2, sumY2, sumXY) {
  if (n < 2) return 0;
  const cov = sumXY - (sumX * sumY) / n;
  const varX = sumX2 - (sumX * sumX) / n;
  const varY = sumY2 - (sumY * sumY) / n;
  if (varX <= 0 || varY <= 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

function toReturnMap(bars) {
  const map = new Map();
  const rets = [];
  let prevC = null;
  for (const b of bars) {
    const t = Number(b?.ts ?? b?.t);
    const c = Number(b?.c);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    if (prevC !== null && prevC > 0) {
      const r = Math.log(c / prevC);
      map.set(t, r);
      rets.push(r);
    }
    prevC = c;
  }
  return { map, rets };
}

export function createLeadLag({
  bucketMs = 250,
  maxLagMs = 5000,
  minSamples = 200,
  impulseZ = 2.0,
  minImpulses = 5,
} = {}) {
  const maxLagBars = Math.max(1, Math.floor(maxLagMs / bucketMs));

  function computeTop({ leaders = [], symbols, getBars, topN = 10, windowBars = 400, params = {} } = {}) {
    const localMinSamples = Number.isFinite(Number(params.minSamples)) ? Math.max(2, Math.trunc(Number(params.minSamples))) : minSamples;
    const localMinImpulses = Number.isFinite(Number(params.minImpulses)) ? Math.max(1, Math.trunc(Number(params.minImpulses))) : minImpulses;
    const localImpulseZ = Number.isFinite(Number(params.impulseZ)) ? Number(params.impulseZ) : impulseZ;
    const localMinCorr = Number.isFinite(Number(params.minCorr)) ? Math.max(0, Math.abs(Number(params.minCorr))) : 0;
    const syms = (Array.isArray(symbols) ? symbols : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);
    const leaderSet = new Set(
      (Array.isArray(leaders) ? leaders : syms)
        .map((s) => String(s).trim().toUpperCase())
        .filter((s) => syms.includes(s)),
    );

    const per = new Map();
    for (const s of syms) {
      const bars = getBars(s, windowBars) || [];
      const sorted = [...bars].sort((a, b) => (a.ts || a.t || 0) - (b.ts || b.t || 0));
      const { map, rets } = toReturnMap(sorted);
      const { std } = meanStd(rets);
      per.set(s, { map, std: std || 0 });
    }

    const results = [];

    for (const leader of syms) {
      if (!leaderSet.has(leader)) continue;
      for (const follower of syms) {
        if (leader === follower) continue;

        const leaderData = per.get(leader);
        const followerData = per.get(follower);
        if (!leaderData || !followerData) continue;

        const leaderStd = leaderData.std;
        const impulseThr = leaderStd > 0 ? localImpulseZ * leaderStd : Infinity;
        let best = null;

        for (let lagBars = -maxLagBars; lagBars <= maxLagBars; lagBars++) {
          if (lagBars === 0) continue;
          const lagMs = lagBars * bucketMs;

          let n = 0;
          let sumX = 0;
          let sumY = 0;
          let sumX2 = 0;
          let sumY2 = 0;
          let sumXY = 0;
          let impulses = 0;

          for (const [tFollower, y] of followerData.map.entries()) {
            const tLeader = tFollower - lagMs;
            const x = leaderData.map.get(tLeader);
            if (x === undefined) continue;

            n++;
            sumX += x;
            sumY += y;
            sumX2 += x * x;
            sumY2 += y * y;
            sumXY += x * y;
            if (Math.abs(x) >= impulseThr) impulses++;
          }

          if (n < 2) continue;
          const corr = pearsonFromSums(n, sumX, sumY, sumX2, sumY2, sumXY);
          const absCorr = Math.abs(corr);
          const confirmed = n >= localMinSamples && impulses >= localMinImpulses && absCorr >= localMinCorr;

          if (!best || (confirmed ? 1 : 0) > (best.confirmed ? 1 : 0) || absCorr > best.absCorr) {
            best = { leader, follower, corr, absCorr, lagMs, samples: n, impulses, confirmed };
          }
        }

        if (!best) continue;

        results.push({
          leader: best.leader,
          follower: best.follower,
          corr: best.corr,
          lagMs: best.lagMs,
          samples: best.samples,
          impulses: best.impulses,
          confirmed: best.confirmed,
        });
      }
    }

    results.sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
      const absDiff = Math.abs(b.corr) - Math.abs(a.corr);
      if (absDiff !== 0) return absDiff;
      return Math.abs(a.lagMs) - Math.abs(b.lagMs);
    });

    return results.slice(0, Math.max(0, topN | 0));
  }

  return { computeTop };
}

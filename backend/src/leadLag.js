// backend/src/leadLag.js
// Rolling lead-lag estimator on fixed-interval microbars.
// Output: top-N pairs with best lag (max |corr|) + confirmation (samples/impulses).

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
  // bars: [{t,c,...}] sorted ascending
  const map = new Map();
  const rets = [];
  let prevC = null;
  for (const b of bars) {
    const t = Number(b?.t);
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
  minSamples = 120,
  impulseZ = 2.0,
  minImpulses = 6,
} = {}) {
  const maxLagBars = Math.max(1, Math.floor(maxLagMs / bucketMs));

  function computeTop({ symbols, getBars, topN = 10, windowBars = 400 } = {}) {
    const syms = (Array.isArray(symbols) ? symbols : [])
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);

    // precompute return maps per symbol
    const per = new Map();
    for (const s of syms) {
      const bars = getBars(s, windowBars) || [];
      const sorted = [...bars].sort((a, b) => (a.t || 0) - (b.t || 0));
      const { map, rets } = toReturnMap(sorted);
      const { std } = meanStd(rets);
      per.set(s, { map, std: std || 0 });
    }

    const results = [];

    for (let i = 0; i < syms.length; i++) {
      for (let j = 0; j < syms.length; j++) {
        if (i === j) continue;
        const leader = syms[i];
        const follower = syms[j];

        const leaderData = per.get(leader);
        const followerData = per.get(follower);
        if (!leaderData || !followerData) continue;
        if (leaderData.map.size < minSamples || followerData.map.size < minSamples) continue;

        const leaderStd = leaderData.std;
        const impulseThr = leaderStd > 0 ? impulseZ * leaderStd : Infinity;

        let best = null;

        for (let lagBars = 1; lagBars <= maxLagBars; lagBars++) {
          const lagMs = lagBars * bucketMs;

          let n = 0;
          let sumX = 0,
            sumY = 0,
            sumX2 = 0,
            sumY2 = 0,
            sumXY = 0;
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

          if (n < minSamples) continue;
          const corr = pearsonFromSums(n, sumX, sumY, sumX2, sumY2, sumXY);
          const absCorr = Math.abs(corr);

          if (!best || absCorr > best.absCorr) {
            best = {
              leader,
              follower,
              corr,
              absCorr,
              lagMs,
              samples: n,
              impulses,
            };
          }
        }

        if (!best) continue;

        const confirmScore = Math.min(1, best.samples / minSamples) * Math.min(1, best.impulses / minImpulses);
        const confirmed = best.samples >= minSamples && best.impulses >= minImpulses;

        results.push({
          leader: best.leader,
          follower: best.follower,
          corr: best.corr,
          lagMs: best.lagMs,
          samples: best.samples,
          impulses: best.impulses,
          confirmScore,
          confirmed,
        });
      }
    }

    results.sort((a, b) => {
      if (b.confirmScore !== a.confirmScore) return b.confirmScore - a.confirmScore;
      const aa = Math.abs(a.corr);
      const bb = Math.abs(b.corr);
      if (bb !== aa) return bb - aa;
      return a.lagMs - b.lagMs;
    });

    return results.slice(0, Math.max(0, topN | 0));
  }

  return { computeTop };
}

function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function hasFreshImpulse(leaderBars, impulseZ, windowMs) {
  if (!Array.isArray(leaderBars) || leaderBars.length < 3) return { pass: false, value: 0, threshold: impulseZ, detail: "no leader bars" };
  const returns = [];
  for (let i = 1; i < leaderBars.length; i++) {
    const prev = n(leaderBars[i - 1]?.c, null);
    const cur = n(leaderBars[i]?.c, null);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push({ ts: n(leaderBars[i]?.ts, 0), r: Math.log(cur / prev) });
  }
  if (returns.length < 3) return { pass: false, value: 0, threshold: impulseZ, detail: "insufficient returns" };
  const vals = returns.map((x) => x.r);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + ((b - mean) ** 2), 0) / Math.max(1, vals.length - 1);
  const std = Math.sqrt(Math.max(variance, 0));
  if (!std) return { pass: false, value: 0, threshold: impulseZ, detail: "zero volatility" };

  const now = Date.now();
  let bestZ = 0;
  for (const row of returns) {
    if (now - row.ts > windowMs) continue;
    const z = Math.abs((row.r - mean) / std);
    if (z > bestZ) bestZ = z;
  }
  return { pass: bestZ >= impulseZ, value: bestZ, threshold: impulseZ, detail: `leader impulse z=${bestZ.toFixed(2)}` };
}

export function evaluateTradeReady({
  row,
  preset,
  excludedCoins = [],
  lastTradeAt = 0,
  getBars,
  bucketMs = 250,
}) {
  const params = preset?.params || {};
  const follower = String(row?.follower || "").toUpperCase();
  const leader = String(row?.leader || "").toUpperCase();
  const followersBars = getBars?.(follower, 200, "BNB") || [];
  const leaderBars = getBars?.(leader, 200, "BNB") || [];

  const blockers = [];

  const confirmed = Boolean(row?.confirmed);
  blockers.push({ key: "confirmed", value: confirmed ? 1 : 0, threshold: 1, pass: confirmed, detail: `samples=${n(row?.samples)} impulses=${n(row?.impulses)}` });

  const cooldownMs = Math.max(0, n(params.cooldownSec, 15)) * 1000;
  const sinceTrade = Date.now() - n(lastTradeAt, 0);
  blockers.push({ key: "cooldown", value: sinceTrade, threshold: cooldownMs, pass: sinceTrade >= cooldownMs, detail: `sinceTradeMs=${Math.trunc(sinceTrade)}` });

  const excluded = excludedCoins.some((x) => String(x?.symbol || "").toUpperCase() === follower && ["ANY", "BNB"].includes(String(x?.source || "ANY").toUpperCase()));
  blockers.push({ key: "excluded", value: excluded ? 1 : 0, threshold: 0, pass: !excluded, detail: excluded ? "follower in blacklist" : "not excluded" });

  const impulseInfo = hasFreshImpulse(leaderBars, n(params.impulseZ, 2), Math.max(bucketMs * 4, n(params.entryWindowMs, 3000)));
  blockers.push({ key: "freshImpulse", value: impulseInfo.value, threshold: impulseInfo.threshold, pass: impulseInfo.pass, detail: impulseInfo.detail });

  let followerMove = 0;
  if (followersBars.length >= 2) {
    const c0 = n(followersBars[followersBars.length - 2]?.c, null);
    const c1 = n(followersBars[followersBars.length - 1]?.c, null);
    if (Number.isFinite(c0) && Number.isFinite(c1) && c0 > 0) followerMove = Math.abs(Math.log(c1 / c0));
  }
  const maxMove = Math.max(0.0001, n(params.edgeMult, 1) * 0.0035);
  blockers.push({ key: "entryWindow", value: followerMove, threshold: maxMove, pass: followerMove <= maxMove, detail: `|ret|=${followerMove.toFixed(5)}` });

  const tradeReady = blockers.every((b) => b.pass);
  const topBlockers = blockers
    .filter((b) => !b.pass)
    .slice(0, 3);

  return {
    tradeReady,
    blockers: topBlockers.length ? topBlockers : blockers.slice(0, 3),
  };
}

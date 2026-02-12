function n(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function hasFreshImpulse(leaderBars, impulseZ, windowMs) {
  if (!Array.isArray(leaderBars) || leaderBars.length < 3) return { pass: false, value: 0, threshold: impulseZ, detail: "no leader bars", sign: 0 };
  const returns = [];
  for (let i = 1; i < leaderBars.length; i++) {
    const prev = n(leaderBars[i - 1]?.c, null);
    const cur = n(leaderBars[i]?.c, null);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push({ ts: n(leaderBars[i]?.ts, 0), r: Math.log(cur / prev) });
  }
  if (returns.length < 3) return { pass: false, value: 0, threshold: impulseZ, detail: "insufficient returns", sign: 0 };
  const vals = returns.map((x) => x.r);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + ((b - mean) ** 2), 0) / Math.max(1, vals.length - 1);
  const std = Math.sqrt(Math.max(variance, 0));
  if (!std) return { pass: false, value: 0, threshold: impulseZ, detail: "zero volatility", sign: 0 };

  const now = Date.now();
  let best = null;
  for (const row of returns) {
    if (now - row.ts > windowMs) continue;
    const zRaw = (row.r - mean) / std;
    const zAbs = Math.abs(zRaw);
    if (!best || zAbs > best.zAbs) best = { zAbs, sign: Math.sign(zRaw) || 0 };
  }
  if (!best) return { pass: false, value: 0, threshold: impulseZ, detail: "no fresh impulse", sign: 0 };
  return { pass: best.zAbs >= impulseZ, value: best.zAbs, threshold: impulseZ, detail: `leader impulse z=${best.zAbs.toFixed(2)} sign=${best.sign >= 0 ? '+' : '-'}`, sign: best.sign };
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
  const followersBars = getBars?.(follower, 200, "BT") || [];
  const leaderBars = getBars?.(leader, 200, "BT") || [];

  const blockers = [];

  const confirmed = Boolean(row?.confirmed);
  blockers.push({ key: "confirmed", value: confirmed ? 1 : 0, threshold: 1, pass: confirmed, detail: `samples=${n(row?.samples)} impulses=${n(row?.impulses)}` });

  const cooldownMs = Math.max(0, n(params.cooldownSec, 15)) * 1000;
  const sinceTrade = Date.now() - n(lastTradeAt, 0);
  blockers.push({ key: "cooldown", value: sinceTrade, threshold: cooldownMs, pass: sinceTrade >= cooldownMs, detail: `sinceTradeMs=${Math.trunc(sinceTrade)}` });

  const excluded = excludedCoins.some((x) => String(x?.symbol || "").toUpperCase() === follower && ["ANY", "BT"].includes(String(x?.source || "ANY").toUpperCase()));
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
  const topBlockers = blockers.filter((b) => !b.pass).slice(0, 3);

  return {
    tradeReady,
    impulseSign: impulseInfo.sign,
    blockers: topBlockers.length ? topBlockers : blockers.slice(0, 3),
  };
}

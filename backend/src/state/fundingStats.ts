import type { FundingBucketRow, PaperPosition } from "../domain/contracts.js";

type Sign = "POS" | "NEG" | "ALL";

const BUCKETS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 0, max: 0.00005, label: "0.000%-0.005%" },
  { min: 0.00005, max: 0.0001, label: "0.005%-0.010%" },
  { min: 0.0001, max: 0.0002, label: "0.010%-0.020%" },
  { min: 0.0002, max: 0.0005, label: "0.020%-0.050%" },
  { min: 0.0005, max: null, label: "0.050%+" },
];

function bucketLabel(absFunding: number): string {
  for (const b of BUCKETS) {
    if (b.max === null) {
      if (absFunding >= b.min) return b.label;
    } else {
      if (absFunding >= b.min && absFunding < b.max) return b.label;
    }
  }
  return BUCKETS[0].label;
}

function signOf(funding: number): Exclude<Sign, "ALL"> {
  return funding >= 0 ? "POS" : "NEG";
}

export function computeFundingBuckets(trades: PaperPosition[]): FundingBucketRow[] {
  const closed = trades.filter((t) => t.status === "CLOSED");
  const map = new Map<string, FundingBucketRow>();

  function addRow(bucket: string, sign: Sign, t: PaperPosition) {
    const key = `${bucket}|${sign}`;
    let row = map.get(key);
    if (!row) {
      row = {
        bucket,
        sign,
        trades: 0,
        wins: 0,
        losses: 0,
        winRatePct: 0,
        netPnlUSDT: 0,
        netFeesUSDT: 0,
        avgRoiPct: 0,
        avgFundingAbs: 0,
      };
      map.set(key, row);
    }

    row.trades += 1;
    const pnl = t.pnlUSDT ?? 0;
    const fees = (t.entryFeeUSDT ?? 0) + (t.exitFeeUSDT ?? 0);
    row.netPnlUSDT += pnl;
    row.netFeesUSDT += fees;

    if (pnl >= 0) row.wins += 1;
    else row.losses += 1;

    row.avgRoiPct += t.pnlRoiPct ?? 0;
    row.avgFundingAbs += t.fundingAbsAtEntry ?? Math.abs(t.fundingRateAtEntry ?? 0);
  }

  for (const t of closed) {
    const absF = t.fundingAbsAtEntry ?? Math.abs(t.fundingRateAtEntry ?? 0);
    const bucket = bucketLabel(absF);
    const sign = signOf(t.fundingRateAtEntry ?? 0);

    addRow(bucket, "ALL", t);
    addRow(bucket, sign, t);
  }

  for (const row of map.values()) {
    row.winRatePct = row.trades > 0 ? (row.wins / row.trades) * 100 : 0;
    row.avgRoiPct = row.trades > 0 ? row.avgRoiPct / row.trades : 0;
    row.avgFundingAbs = row.trades > 0 ? row.avgFundingAbs / row.trades : 0;
  }

  const signOrder: Record<Sign, number> = { ALL: 0, POS: 1, NEG: 2 };
  const bucketOrder = new Map(BUCKETS.map((b, i) => [b.label, i]));
  return [...map.values()].sort((a, b) => {
    const bo = (bucketOrder.get(a.bucket) ?? 999) - (bucketOrder.get(b.bucket) ?? 999);
    if (bo !== 0) return bo;
    return signOrder[a.sign] - signOrder[b.sign];
  });
}

import type { UniverseConfig, SymbolMetrics } from "../domain/contracts.js";
import { BybitRest } from "../bybit/bybitRest.js";

/**
 * Universe Builder (Step 3)
 * - Fetch linear instruments (pagination with cursor)
 * - Filter to USDT perpetual instruments
 * - Fetch tickers (linear)
 * - Compute:
 *   - turnover24h (USDT)
 *   - volatilityPct = (highPrice24h - lowPrice24h) / lowPrice24h * 100
 * - Apply filters: minTurnoverUSDT, minVolatilityPct
 *
 * NOTE: "current day" volatility approximated using 24h high/low from tickers.
 */

type InstrumentsInfoResult = {
  category: string;
  nextPageCursor?: string;
  list: Array<{
    symbol: string;
    status: string;
    quoteCoin?: string;
    contractType?: string;
    settleCoin?: string;
  }>;
};

type TickersResult = {
  category: string;
  list: Array<{
    symbol: string;
    lastPrice?: string;
    markPrice?: string;
    highPrice24h?: string;
    lowPrice24h?: string;
    turnover24h?: string;
    fundingRate?: string;
    nextFundingTime?: string; // ms
  }>;
};

export interface UniverseBuildResult {
  totalEligibleSymbols: number;
  selectedSymbols: string[];
  symbolMetrics: SymbolMetrics[];
}

function toNum(v: string | undefined, fallback = 0): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function volatilityPct(high: number, low: number): number {
  if (low <= 0) return 0;
  return ((high - low) / low) * 100;
}

function fundingWindow(nextFundingMs: number): { fundingTimeMs: number; nextFundingTimeMs: number } {
  const now = Date.now();
  return { fundingTimeMs: now, nextFundingTimeMs: nextFundingMs || now };
}

export async function buildUniverse(opts: {
  rest: BybitRest;
  config: UniverseConfig;
}): Promise<UniverseBuildResult> {
  const { rest, config } = opts;

  const eligible = new Set<string>();
  let cursor: string | undefined = undefined;

  while (true) {
    const resp = await rest.getJson<InstrumentsInfoResult>("/v5/market/instruments-info", {
      category: "linear",
      limit: 500,
      cursor,
    });

    if (resp.retCode !== 0) {
      throw new Error(`Bybit instruments-info retCode=${resp.retCode} retMsg=${resp.retMsg}`);
    }

    for (const it of resp.result?.list ?? []) {
      const sym = it.symbol;
      if (!sym) continue;
      if (it.status && it.status !== "Trading") continue;

      const quote = (it.quoteCoin ?? "").toUpperCase();
      const settle = (it.settleCoin ?? "").toUpperCase();
      if (quote !== "USDT" && settle !== "USDT") continue;

      const ct = (it.contractType ?? "").toLowerCase();
      if (ct.includes("futures")) continue;

      eligible.add(sym);
    }

    cursor = resp.result?.nextPageCursor;
    if (!cursor) break;
  }

  const tickersResp = await rest.getJson<TickersResult>("/v5/market/tickers", { category: "linear" });
  if (tickersResp.retCode !== 0) {
    throw new Error(`Bybit tickers retCode=${tickersResp.retCode} retMsg=${tickersResp.retMsg}`);
  }

  const tickerMap = new Map<string, TickersResult["list"][number]>();
  for (const t of tickersResp.result?.list ?? []) {
    if (t.symbol) tickerMap.set(t.symbol, t);
  }

  const selected: string[] = [];
  const metrics: SymbolMetrics[] = [];

  for (const sym of eligible) {
    const t = tickerMap.get(sym);
    if (!t) continue;

    const high = toNum(t.highPrice24h);
    const low = toNum(t.lowPrice24h);
    const vol = volatilityPct(high, low);

    const turnover = toNum(t.turnover24h);
    if (turnover < config.minTurnoverUSDT) continue;
    if (vol < config.minVolatilityPct) continue;

    const mark = toNum(t.markPrice, toNum(t.lastPrice));
    const fr = toNum(t.fundingRate);
    const nextFunding = toNum(t.nextFundingTime);

    selected.push(sym);
    const fw = fundingWindow(nextFunding);

    metrics.push({
      symbol: sym,
      markPrice: mark,
      priceDeltaPct: 0,
      oiValue: 0,
      oiDeltaPct: 0,
      fundingRate: fr,
      fundingTimeMs: fw.fundingTimeMs,
      nextFundingTimeMs: fw.nextFundingTimeMs,
      status: "WAITING_CANDLE",
      reason: "universe built; waiting previous candle",
      triggerCountToday: 0,
    });
  }

  selected.sort();

  return {
    totalEligibleSymbols: eligible.size,
    selectedSymbols: selected,
    symbolMetrics: metrics.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

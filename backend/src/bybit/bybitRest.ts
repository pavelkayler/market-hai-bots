/**
 * Minimal Bybit REST helper (public endpoints).
 * Used for Universe building and utility pages (Requests).
 *
 * Base URL defaults to https://api.bybit.com
 */
export interface BybitRestOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface BybitRestResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time: number;
}

export class BybitRest {
  constructor(private readonly opts: BybitRestOptions) {}

  async getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<BybitRestResponse<T>> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);

    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Bybit REST ${res.status}: ${text.slice(0, 200)}`);
    }

    return (await res.json()) as BybitRestResponse<T>;
  }

  // --- Requests Page helpers (public REST) ---

  /** List all LINEAR USDT perpetual symbols currently Trading. */
  async listUsdtPerpSymbols(): Promise<string[]> {
    const data = await this.getJson<any>("/v5/market/instruments-info", {
      category: "linear",
      status: "Trading",
      limit: "1000",
    });

    const list: any[] = (data as any)?.result?.list ?? [];
    return list
      .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
      .map((x) => x.symbol)
      .sort((a, b) => a.localeCompare(b));
  }

  async getTicker(symbol: string): Promise<any> {
    return this.getJson<any>("/v5/market/tickers", { category: "linear", symbol });
  }

  async getInstrumentsInfo(symbol: string): Promise<any> {
    return this.getJson<any>("/v5/market/instruments-info", { category: "linear", symbol });
  }

  async getFundingRate(symbol: string): Promise<any> {
    return this.getJson<any>("/v5/market/funding/history", { category: "linear", symbol, limit: "1" });
  }

  async getOpenInterest(symbol: string): Promise<any> {
    return this.getJson<any>("/v5/market/open-interest", { category: "linear", symbol, intervalTime: "5min", limit: "1" });
  }

  async getKline(symbol: string, interval: string = "1", limit: string = "2"): Promise<any> {
    return this.getJson<any>("/v5/market/kline", { category: "linear", symbol, interval, limit });
  }
}

import type {
  BotSnapshot,
  BotRunState,
  PaperOrder,
  PaperPosition,
  SymbolMetrics,
  TradeResultRow,
  UniverseConfig,
  BotConfig,
  UniversePreset,
} from "../domain/contracts.js";
import { defaultBotConfig, defaultUniverseConfig } from "../domain/defaults.js";
import { computeFundingBuckets } from "./fundingStats.js";
import { dayKeyMsk } from "../strategy/dayKey.js";

export class Store {
  onUniverseRebuilt?: (symbols: string[]) => void;

  botRunState: BotRunState = "STOPPED";
  backendToBybit: "CONNECTED" | "DISCONNECTED" = "DISCONNECTED";

  // currently selected universe (active)
  universe: { totalSymbols: number; selectedSymbols: number; symbols: string[] } = {
    totalSymbols: 0,
    selectedSymbols: 0,
    symbols: [],
  };

  universeConfig: UniverseConfig = { ...defaultUniverseConfig };
  botConfig: BotConfig = { ...defaultBotConfig };

  symbols: SymbolMetrics[] = [];
  openOrders: PaperOrder[] = [];
  openPositions: PaperPosition[] = [];
  tradeHistory: PaperPosition[] = [];

  savedUniverses: UniversePreset[] = [];
  currentUniverseName: string | null = null;

  // Signals table cache (recompute max every 10s)
  private signalRowsCache: any[] = [];
  private signalsUpdatedAtMs = 0;

  // Day-open tracking for "change today" columns (MSK day)
  private dayOpenPrice = new Map<string, number>();
  private dayOpenOiValue = new Map<string, number>();
  private dayKeyMemo: string | null = null;

  public getSymbol(symbol: string) {
    return this.symbols.find((s) => s.symbol === symbol) ?? null;
  }

  public forceSignalsRefresh(): void {
    this.signalsUpdatedAtMs = 0;
  }

  private updateDayOpen(nowMs: number) {
    const dk = dayKeyMsk(nowMs);
    if (this.dayKeyMemo !== dk) {
      this.dayKeyMemo = dk;
      this.dayOpenPrice.clear();
      this.dayOpenOiValue.clear();
      for (const s of this.symbols) {
        if (Number.isFinite(s.markPrice) && (s.markPrice ?? 0) > 0) this.dayOpenPrice.set(s.symbol, s.markPrice!);
        if (Number.isFinite(s.oiValue) && (s.oiValue ?? 0) > 0) this.dayOpenOiValue.set(s.symbol, s.oiValue!);
      }
      return;
    }
    for (const s of this.symbols) {
      if (!this.dayOpenPrice.has(s.symbol) && Number.isFinite(s.markPrice) && (s.markPrice ?? 0) > 0) {
        this.dayOpenPrice.set(s.symbol, s.markPrice!);
      }
      if (!this.dayOpenOiValue.has(s.symbol) && Number.isFinite(s.oiValue) && (s.oiValue ?? 0) > 0) {
        this.dayOpenOiValue.set(s.symbol, s.oiValue!);
      }
    }
  }

  private computeSignalRows(nowMs: number): { rows: any[]; updatedAtMs: number } {
    if (nowMs - this.signalsUpdatedAtMs < 10_000 && this.signalRowsCache.length > 0) {
      return { rows: this.signalRowsCache, updatedAtMs: this.signalsUpdatedAtMs };
    }

    this.updateDayOpen(nowMs);

    const universeSet = new Set(this.universe.symbols ?? []);
    const dk = this.dayKeyMemo ?? dayKeyMsk(nowMs);

    // trades stats today: opened + wins (closed pnl >= 0) by symbol
    const tradeStats = new Map<string, { tradesOpenedToday: number; winsToday: number }>();
    for (const t of this.tradeHistory) {
      const sym = t.symbol;
      if (!universeSet.has(sym)) continue;

      let st = tradeStats.get(sym);
      if (!st) {
        st = { tradesOpenedToday: 0, winsToday: 0 };
        tradeStats.set(sym, st);
      }
      if (t.openedAtMs && dayKeyMsk(t.openedAtMs) === dk) st.tradesOpenedToday += 1;
      if (t.closedAtMs && dayKeyMsk(t.closedAtMs) === dk) {
        if ((t.pnlUSDT ?? 0) >= 0) st.winsToday += 1;
      }
    }

    const rows: any[] = [];
    for (const s of this.symbols) {
      const sym = s.symbol;
      if (!universeSet.has(sym)) continue;

      const openP = this.dayOpenPrice.get(sym);
      const openOi = this.dayOpenOiValue.get(sym);

      const priceChangeTodayPct =
        openP && openP > 0 && Number.isFinite(s.markPrice) ? (((s.markPrice ?? 0) - openP) / openP) * 100 : null;

      const oiValueChangeTodayPct =
        openOi && openOi > 0 && Number.isFinite(s.oiValue) ? (((s.oiValue ?? 0) - openOi) / openOi) * 100 : null;

      const lastUpdateAgeSec = s.lastUpdateMs ? Math.max(0, Math.floor((nowMs - s.lastUpdateMs) / 1000)) : null;

      const ts = tradeStats.get(sym) ?? { tradesOpenedToday: 0, winsToday: 0 };

      rows.push({
        symbol: sym,
        currentPrice: s.markPrice ?? 0,
        lastSignalAtMs: (s as any).lastSignalAtMs ?? null,
        signalCountToday: (s as any).triggerCountToday ?? 0,
        tradesOpenedToday: ts.tradesOpenedToday,
        winsToday: ts.winsToday,
        priceChangeTodayPct,
        oiValueChangeTodayPct,
        lastUpdateAgeSec,
      });
    }

    this.signalRowsCache = rows;
    this.signalsUpdatedAtMs = nowMs;
    return { rows, updatedAtMs: nowMs };
  }

  snapshot(): BotSnapshot {
    const nowMs = Date.now();

    const entryFeesUSDT =
      this.tradeHistory.reduce((a, p) => a + ((p as any).entryFeeUSDT ?? 0), 0) +
      this.openPositions.reduce((a, p) => a + ((p as any).entryFeeUSDT ?? 0), 0);
    const exitFeesUSDT =
      this.tradeHistory.reduce((a, p) => a + ((p as any).exitFeeUSDT ?? 0), 0) +
      this.openPositions.reduce((a, p) => a + ((p as any).exitFeeUSDT ?? 0), 0);
    const totalFeesUSDT = entryFeesUSDT + exitFeesUSDT;

    const signals = this.computeSignalRows(nowMs);

    const tradeResults = computeTradeResults(this.tradeHistory);

    return {
      serverTimeMs: nowMs,
      wsStatus: {
        backendToBybit: this.backendToBybit,
        lastHeartbeatMs: nowMs,
      },
      connections: {
        frontendToBackend: "CONNECTED",
        backendToBybit: this.backendToBybit,
      },
      botRunState: this.botRunState,
      universe: { totalSymbols: this.universe.totalSymbols, selectedSymbols: this.universe.selectedSymbols },
      configs: {
        universeConfig: this.universeConfig,
        botConfig: this.botConfig,
      },
      symbols: this.symbols,
      openOrders: this.openOrders.filter((o) => o.status === "OPEN"),
      openPositions: this.openPositions.filter((p) => p.status === "OPEN"),
      tradeHistory: this.tradeHistory,
      tradeResults,
      tradeResultsBySymbol: tradeResults,
      fundingStats: { buckets: computeFundingBuckets(this.tradeHistory) },
      feesSummary: { entryFeesUSDT, exitFeesUSDT, totalFeesUSDT },
      signalRows: signals.rows as any,
      signalsUpdatedAtMs: signals.updatedAtMs,
      savedUniverses: this.savedUniverses,
      currentUniverseName: this.currentUniverseName,
    };
  }
}

export function createStore(): Store {
  return new Store();
}

export function resetStore(s: Store): void {
  s.botRunState = "STOPPED";
  s.backendToBybit = "DISCONNECTED";

  s.universeConfig = { ...defaultUniverseConfig };
  s.botConfig = { ...defaultBotConfig };

  s.universe = { totalSymbols: 0, selectedSymbols: 0, symbols: [] };
  s.symbols = [];
  s.openOrders = [];
  s.openPositions = [];
  s.tradeHistory = [];

  s.savedUniverses = [];
  s.currentUniverseName = null;

  s.forceSignalsRefresh();
}

function computeTradeResults(history: PaperPosition[]): TradeResultRow[] {
  const m = new Map<
    string,
    { trades: number; wins: number; losses: number; netPnlUSDT: number; netRoiPct: number; sumRoiPct: number }
  >();

  for (const t of history) {
    if (t.status !== "CLOSED") continue;
    const sym = t.symbol;
    const pnl = (t.pnlUSDT ?? 0) - ((t as any).entryFeeUSDT ?? 0) - ((t as any).exitFeeUSDT ?? 0);
    const roi = t.pnlRoiPct ?? 0;
    const hit = m.get(sym) ?? { trades: 0, wins: 0, losses: 0, netPnlUSDT: 0, netRoiPct: 0, sumRoiPct: 0 };
    hit.trades += 1;
    if (pnl >= 0) hit.wins += 1;
    else hit.losses += 1;
    hit.netPnlUSDT += pnl;
    hit.netRoiPct += roi;
    hit.sumRoiPct += roi;
    m.set(sym, hit);
  }

  const rows: TradeResultRow[] = [];
  for (const [symbol, v] of m.entries()) {
    const winRatePct = v.trades > 0 ? (v.wins / v.trades) * 100 : 0;
    const avgRoiPct = v.trades > 0 ? v.sumRoiPct / v.trades : 0;
    rows.push({
      symbol,
      trades: v.trades,
      wins: v.wins,
      losses: v.losses,
      winRatePct,
      netPnlUSDT: v.netPnlUSDT,
      netRoiPct: v.netRoiPct,
      avgRoiPct,
    });
  }
  return rows;
}

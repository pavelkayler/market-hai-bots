import type { Timeframe } from "../domain/contracts.js";
import { CandleEngine } from "./candleEngine.js";

export class SymbolCandleManager {
  private engines = new Map<string, CandleEngine>();
  private tf: Timeframe;

  constructor(tf: Timeframe) {
    this.tf = tf;
  }

  setTimeframe(tf: Timeframe) {
    if (tf === this.tf) return;
    this.tf = tf;
    for (const e of this.engines.values()) e.setTimeframe(tf);
  }

  resetSymbols(symbols: string[]) {
    // keep engines only for active symbols
    const keep = new Set(symbols);
    for (const k of this.engines.keys()) {
      if (!keep.has(k)) this.engines.delete(k);
    }
    for (const s of symbols) {
      if (!this.engines.has(s)) this.engines.set(s, new CandleEngine(this.tf));
      else this.engines.get(s)!.reset();
    }
  }

  get(symbol: string): CandleEngine {
    const ex = this.engines.get(symbol);
    if (ex) return ex;
    const e = new CandleEngine(this.tf);
    this.engines.set(symbol, e);
    return e;
  }
}

export type TickerUpdate = {
  symbol: string;
  markPrice: number;
  openInterestValue: number;
  ts: number;
  lastPrice?: number | null;
  bid?: number | null;
  ask?: number | null;
  spreadBps?: number | null;
  lastTickTs?: number;
};

export interface TickerStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  setSymbols(symbols: string[]): Promise<void>;
  onTicker(handler: (update: TickerUpdate) => void): () => void;
}

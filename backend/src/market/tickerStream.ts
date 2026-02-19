export type TickerUpdate = {
  symbol: string;
  markPrice: number;
  openInterestValue?: number | null;
  fundingRate?: number | null;
  nextFundingTimeMs?: number | null;
  ts: number;
  lastPrice?: number | null;
  bid?: number | null;
  ask?: number | null;
  spreadBps?: number | null;
  lastTickTs?: number;
};

export type TickerStreamStatus = {
  running: boolean;
  connected: boolean;
  desiredSymbolsCount: number;
  subscribedCount: number;
  lastMessageAt: number | null;
  lastTickerAt: number | null;
  reconnectCount: number;
  lastError: string | null;
};

export interface TickerStream {
  start(): Promise<void>;
  stop(): Promise<void>;
  setSymbols(symbols: string[]): Promise<void>;
  onTicker(handler: (update: TickerUpdate) => void): () => void;
  getStatus?(): TickerStreamStatus;
}

export type PaperPendingOrder = {
  symbol: string;
  side: 'Buy' | 'Sell';
  limitPrice: number;
  qty: number;
  placedTs: number;
  expiresTs: number;
};

export type PaperPosition = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  qty: number;
  tpPrice: number;
  slPrice: number;
  openedTs: number;
  lastPnlUSDT?: number;
};

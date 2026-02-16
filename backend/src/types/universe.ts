export type UniverseEntry = {
  symbol: string;
  turnover24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  vol24hPct: number;
  forcedActive: boolean;
  qtyStep: number | null;
  minOrderQty: number | null;
  maxOrderQty: number | null;
};

export type UniverseState = {
  createdAt: number;
  filters: {
    minTurnover: number;
    minVolPct: number;
  };
  symbols: UniverseEntry[];
  ready: boolean;
};

export type UniverseFilters = UniverseState['filters'];

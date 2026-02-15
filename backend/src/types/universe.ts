export type UniverseEntry = {
  symbol: string;
  turnover24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  vol24hPct: number;
  forcedActive: boolean;
};

export type UniverseState = {
  createdAt: number;
  filters: {
    minTurnover: 10000000;
    minVolPct: number;
  };
  symbols: UniverseEntry[];
  ready: boolean;
};

export type UniverseFilters = UniverseState['filters'];

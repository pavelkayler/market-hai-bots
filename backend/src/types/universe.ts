export type UniverseEntry = {
  symbol: string;
  turnover24hUSDT: number;
  turnover24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  vol24hRangePct: number;
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
  metricDefinition?: {
    volDefinition: string;
    turnoverDefinition: string;
  };
  symbols: UniverseEntry[];
  ready: boolean;
  totalSymbols?: number;
  validSymbols?: number;
  filteredOut?: {
    expiringOrNonPerp: number;
  };
  contractFilter?: 'USDT_LINEAR_PERPETUAL_ONLY';
  notReadyReason?: string;
};

export type UniverseFilters = UniverseState['filters'];

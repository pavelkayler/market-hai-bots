import type { InstrumentLinear } from '../services/bybitMarketClient.js';

export type WsTickerEvent = {
  symbol: string;
  markPrice: number;
  openInterestValue: number;
  ts: number;
};

export type DemoOpenOrder = {
  orderId?: string;
  orderLinkId?: string;
  orderStatus?: string;
  symbol?: string;
};

export type DemoPosition = {
  symbol: string;
  size: number;
  entryPrice: number | null;
  side: string | null;
  positionIdx: number | null;
  leverage?: number | null;
  unrealisedPnl?: number | null;
};

type DemoPositionListEntry = {
  positionIdx?: number;
  symbol?: string;
  side?: string;
  size?: string;
  avgPrice?: string;
  leverage?: string;
  unrealisedPnl?: string;
};

const parseFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

type BybitListResponse = {
  result?: {
    list?: unknown[];
  };
};

export const parseWsTickerEvent = (json: unknown): WsTickerEvent | null => {
  if (!json || typeof json !== 'object') {
    return null;
  }

  const packet = json as {
    topic?: unknown;
    data?: unknown;
    ts?: unknown;
  };

  if (typeof packet.topic !== 'string' || !packet.topic.startsWith('tickers.')) {
    return null;
  }

  const rawData = Array.isArray(packet.data) ? packet.data[0] : packet.data;
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }

  const data = rawData as {
    symbol?: unknown;
    markPrice?: unknown;
    openInterestValue?: unknown;
  };

  if (typeof data.symbol !== 'string') {
    return null;
  }

  const markPrice = parseFiniteNumber(data.markPrice);
  const openInterestValue = parseFiniteNumber(data.openInterestValue);
  const ts = parseFiniteNumber(packet.ts);

  if (markPrice === null || openInterestValue === null || ts === null) {
    return null;
  }

  return {
    symbol: data.symbol,
    markPrice,
    openInterestValue,
    ts
  };
};

export const parseInstrumentsInfo = (json: unknown): InstrumentLinear[] => {
  const rows = (json as BybitListResponse | null)?.result?.list ?? [];
  const instruments: InstrumentLinear[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const symbol = typeof (row as { symbol?: unknown }).symbol === 'string' ? (row as { symbol: string }).symbol : null;
    if (!symbol) {
      continue;
    }

    const lotSizeFilter = (row as { lotSizeFilter?: Record<string, unknown> }).lotSizeFilter;
    instruments.push({
      symbol,
      category: typeof (row as { category?: unknown }).category === 'string' ? (row as { category: string }).category : null,
      contractType:
        typeof (row as { contractType?: unknown }).contractType === 'string'
          ? (row as { contractType: string }).contractType
          : null,
      status: typeof (row as { status?: unknown }).status === 'string' ? (row as { status: string }).status : null,
      settleCoin:
        typeof (row as { settleCoin?: unknown }).settleCoin === 'string'
          ? (row as { settleCoin: string }).settleCoin
          : null,
      quoteCoin: typeof (row as { quoteCoin?: unknown }).quoteCoin === 'string' ? (row as { quoteCoin: string }).quoteCoin : null,
      baseCoin: typeof (row as { baseCoin?: unknown }).baseCoin === 'string' ? (row as { baseCoin: string }).baseCoin : null,
      qtyStep: parseFiniteNumber(lotSizeFilter?.qtyStep),
      minOrderQty: parseFiniteNumber(lotSizeFilter?.minOrderQty),
      maxOrderQty: parseFiniteNumber(lotSizeFilter?.maxOrderQty)
    });
  }

  return instruments;
};

export const parseOpenOrders = (json: unknown): DemoOpenOrder[] => {
  const rows = (json as BybitListResponse | null)?.result?.list ?? [];
  const orders: DemoOpenOrder[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    orders.push({
      orderId: typeof (row as { orderId?: unknown }).orderId === 'string' ? (row as { orderId: string }).orderId : undefined,
      orderLinkId:
        typeof (row as { orderLinkId?: unknown }).orderLinkId === 'string'
          ? (row as { orderLinkId: string }).orderLinkId
          : undefined,
      orderStatus:
        typeof (row as { orderStatus?: unknown }).orderStatus === 'string'
          ? (row as { orderStatus: string }).orderStatus
          : undefined,
      symbol: typeof (row as { symbol?: unknown }).symbol === 'string' ? (row as { symbol: string }).symbol : undefined
    });
  }

  return orders;
};

export const parsePositions = (json: unknown): DemoPosition[] => {
  const rows = (json as BybitListResponse | null)?.result?.list ?? [];
  const positions: DemoPosition[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const position = row as DemoPositionListEntry;
    if (typeof position.symbol !== 'string') {
      continue;
    }

    positions.push({
      symbol: position.symbol,
      size: Number(position.size ?? '0'),
      entryPrice: position.avgPrice ? Number(position.avgPrice) : null,
      side: position.side ?? null,
      positionIdx: typeof position.positionIdx === 'number' ? position.positionIdx : null,
      leverage: position.leverage ? Number(position.leverage) : null,
      unrealisedPnl: position.unrealisedPnl ? Number(position.unrealisedPnl) : null
    });
  }

  return positions;
};

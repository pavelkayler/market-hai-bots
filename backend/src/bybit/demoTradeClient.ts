import { request } from 'undici';

import { buildBybitV5Headers } from './bybitSigner.js';

export type DemoCreateOrderParams = {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price: string;
  orderLinkId: string;
  takeProfit: string;
  stopLoss: string;
};

export type DemoCreateOrderResult = {
  orderId: string;
  orderLinkId: string;
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

export interface IDemoTradeClient {
  createLimitOrderWithTpSl(params: DemoCreateOrderParams): Promise<DemoCreateOrderResult>;
  cancelOrder(params: { symbol: string; orderId?: string; orderLinkId?: string }): Promise<void>;
  getOpenOrders(symbol: string): Promise<DemoOpenOrder[]>;
  getPosition(symbol: string): Promise<DemoPosition | null>;
}

type BybitV5Response = {
  retCode: number;
  retMsg: string;
  result?: {
    orderId?: string;
    orderLinkId?: string;
    list?: Array<DemoOpenOrder | DemoPositionListEntry>;
  };
};

export class DemoTradeClient implements IDemoTradeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(options?: { baseUrl?: string; apiKey?: string; apiSecret?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.BYBIT_DEMO_REST ?? 'https://api-demo.bybit.com';
    this.apiKey = options?.apiKey ?? process.env.DEMO_API_KEY ?? '';
    this.apiSecret = options?.apiSecret ?? process.env.DEMO_API_SECRET ?? '';
  }

  async createLimitOrderWithTpSl(params: DemoCreateOrderParams): Promise<DemoCreateOrderResult> {
    const body = JSON.stringify({
      category: 'linear',
      symbol: params.symbol,
      side: params.side,
      orderType: 'Limit',
      qty: params.qty,
      price: params.price,
      timeInForce: 'GTC',
      orderLinkId: params.orderLinkId,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      tpTriggerBy: 'MarkPrice',
      slTriggerBy: 'MarkPrice'
    });

    const json = await this.post('/v5/order/create', body);
    if (json.retCode !== 0 || !json.result?.orderId || !json.result.orderLinkId) {
      throw new Error(`Demo create order failed: ${json.retCode} ${json.retMsg}`);
    }

    return {
      orderId: json.result.orderId,
      orderLinkId: json.result.orderLinkId
    };
  }

  async cancelOrder(params: { symbol: string; orderId?: string; orderLinkId?: string }): Promise<void> {
    const body = JSON.stringify({
      category: 'linear',
      symbol: params.symbol,
      orderId: params.orderId,
      orderLinkId: params.orderLinkId
    });

    const json = await this.post('/v5/order/cancel', body);
    if (json.retCode !== 0) {
      throw new Error(`Demo cancel order failed: ${json.retCode} ${json.retMsg}`);
    }
  }

  async getOpenOrders(symbol: string): Promise<DemoOpenOrder[]> {
    const query = new URLSearchParams({ category: 'linear', symbol });
    const queryString = query.toString();
    const headers = this.buildSignedHeaders('GET', queryString);
    const response = await request(`${this.baseUrl}/v5/order/realtime?${queryString}`, {
      method: 'GET',
      headers
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Demo open orders failed with status ${response.statusCode}`);
    }

    const json = (await response.body.json()) as BybitV5Response;
    if (json.retCode !== 0) {
      throw new Error(`Demo open orders failed: ${json.retCode} ${json.retMsg}`);
    }

    return (json.result?.list ?? []) as DemoOpenOrder[];
  }

  async getPosition(symbol: string): Promise<DemoPosition | null> {
    const query = new URLSearchParams({ category: 'linear', symbol });
    const queryString = query.toString();
    const headers = this.buildSignedHeaders('GET', queryString);
    const response = await request(`${this.baseUrl}/v5/position/list?${queryString}`, {
      method: 'GET',
      headers
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Demo position list failed with status ${response.statusCode}`);
    }

    const json = (await response.body.json()) as BybitV5Response;
    if (json.retCode !== 0) {
      throw new Error(`Demo position list failed: ${json.retCode} ${json.retMsg}`);
    }

    const position = (json.result?.list ?? []).find((entry) => entry.symbol === symbol) as DemoPositionListEntry | undefined;
    if (!position) {
      return null;
    }

    return {
      symbol,
      size: Number(position.size ?? '0'),
      entryPrice: position.avgPrice ? Number(position.avgPrice) : null,
      side: position.side ?? null,
      positionIdx: typeof position.positionIdx === 'number' ? position.positionIdx : null,
      leverage: position.leverage ? Number(position.leverage) : null,
      unrealisedPnl: position.unrealisedPnl ? Number(position.unrealisedPnl) : null
    };
  }

  private async post(path: string, body: string): Promise<BybitV5Response> {
    const response = await request(`${this.baseUrl}${path}`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        ...this.buildSignedHeaders('POST', undefined, body)
      }
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Demo trade request failed with status ${response.statusCode}`);
    }

    return response.body.json() as Promise<BybitV5Response>;
  }

  private buildSignedHeaders(method: 'GET' | 'POST', queryString?: string, body?: string): Record<string, string> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Demo API credentials are missing');
    }

    return buildBybitV5Headers({
      method,
      apiKey: this.apiKey,
      apiSecret: this.apiSecret,
      timestamp: Date.now(),
      queryString,
      body
    });
  }
}

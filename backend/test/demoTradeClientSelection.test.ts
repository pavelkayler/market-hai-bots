import { describe, expect, it } from 'vitest';

import { DemoTradeClient, selectBestPositionForSymbol, type DemoPosition } from '../src/bybit/demoTradeClient.js';

describe('demoTradeClient position selection', () => {
  it('prefers non-zero long leg when short hedge leg is zero', () => {
    const positions: DemoPosition[] = [
      { symbol: 'BTCUSDT', side: 'Buy', size: 0.01, positionIdx: 1, entryPrice: 100 },
      { symbol: 'BTCUSDT', side: 'Sell', size: 0, positionIdx: 2, entryPrice: null }
    ];

    expect(selectBestPositionForSymbol('BTCUSDT', positions)).toMatchObject({ side: 'Buy', positionIdx: 1 });
  });

  it('prefers largest absolute non-zero size when multiple matches exist', () => {
    const positions: DemoPosition[] = [
      { symbol: 'BTCUSDT', side: 'Buy', size: 0.005, positionIdx: 1, entryPrice: 100 },
      { symbol: 'BTCUSDT', side: 'Sell', size: -0.02, positionIdx: 2, entryPrice: 102 },
      { symbol: 'ETHUSDT', side: 'Buy', size: 1, positionIdx: 1, entryPrice: 10 }
    ];

    expect(selectBestPositionForSymbol('BTCUSDT', positions)).toMatchObject({ side: 'Sell', positionIdx: 2, size: -0.02 });
  });

  it('returns null when no non-zero position is open for symbol', () => {
    const positions: DemoPosition[] = [{ symbol: 'BTCUSDT', side: 'Buy', size: 0, positionIdx: 1, entryPrice: null }];
    expect(selectBestPositionForSymbol('BTCUSDT', positions)).toBeNull();
  });

  it('defaults to hedge-mode idx mapping for opens and closes', async () => {
    class TestClient extends DemoTradeClient {
      public readonly bodies: string[] = [];

      protected override async post(_path: string, body: string): Promise<{ retCode: number; retMsg: string; result?: { orderId?: string; orderLinkId?: string } }> {
        this.bodies.push(body);
        return { retCode: 0, retMsg: 'OK', result: { orderId: '1', orderLinkId: '1' } };
      }
    }

    const client = new TestClient({ apiKey: 'k', apiSecret: 's' });
    await client.createLimitOrderWithTpSl({ symbol: 'BTCUSDT', side: 'Buy', qty: '1', price: '1', orderLinkId: 'x', takeProfit: '2', stopLoss: '0.5' });
    await client.closePositionMarket({ symbol: 'BTCUSDT', side: 'Sell', qty: '1' });
    await client.closePositionMarket({ symbol: 'BTCUSDT', side: 'Buy', qty: '1' });

    expect(client.bodies[0]).toContain('"positionIdx":1');
    expect(client.bodies[1]).toContain('"positionIdx":1');
    expect(client.bodies[2]).toContain('"positionIdx":2');
  });
});

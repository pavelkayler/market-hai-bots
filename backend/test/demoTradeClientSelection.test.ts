import { describe, expect, it } from 'vitest';

import { selectBestPositionForSymbol, type DemoPosition } from '../src/bybit/demoTradeClient.js';

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
});

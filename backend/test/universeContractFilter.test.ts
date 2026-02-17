import { describe, expect, it } from 'vitest';

import type { InstrumentLinear } from '../src/services/bybitMarketClient.js';
import { classifyUsdtLinearPerpetualInstrument, isUsdtLinearPerpetualInstrument } from '../src/services/universeContractFilter.js';

const instrument = (partial: Partial<InstrumentLinear>): InstrumentLinear => ({
  symbol: 'BTCUSDT',
  category: 'linear',
  contractType: 'PERPETUAL',
  status: 'Trading',
  settleCoin: 'USDT',
  quoteCoin: 'USDT',
  baseCoin: 'BTC',
  qtyStep: null,
  minOrderQty: null,
  maxOrderQty: null,
  ...partial
});

describe('isUsdtLinearPerpetualInstrument', () => {
  it('includes standard USDT linear perpetual symbol', () => {
    expect(isUsdtLinearPerpetualInstrument(instrument({ symbol: 'BTCUSDT' }))).toBe(true);
  });

  it('excludes expiring symbols and non-perpetual contracts', () => {
    expect(
      classifyUsdtLinearPerpetualInstrument(
        instrument({
          symbol: 'BTCUSDT-26JUN26',
          contractType: 'Futures',
          deliveryTime: '1782345600000'
        })
      )
    ).toEqual({ included: false, reason: 'expiring' });
  });

  it('excludes non-linear or non-USDT products', () => {
    expect(
      isUsdtLinearPerpetualInstrument(
        instrument({
          symbol: 'BTCUSD',
          category: 'inverse',
          quoteCoin: 'USD'
        })
      )
    ).toBe(false);
  });

  it('marks missing official fields as unknown', () => {
    expect(classifyUsdtLinearPerpetualInstrument(instrument({ symbol: 'BTCPERP', settleCoin: null, quoteCoin: null }))).toEqual({ included: false, reason: 'unknown' });
  });
});

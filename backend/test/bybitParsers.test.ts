import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseInstrumentsInfo, parseOpenOrders, parsePositions, parseWsTickerEvent } from '../src/bybit/parsers.js';

const readFixture = (fileName: string): unknown => {
  const fixturePath = resolve(import.meta.dirname, 'fixtures/bybit', fileName);
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
};

describe('Bybit parsers', () => {
  it('parses ws ticker event fixture into numeric values', () => {
    const fixture = readFixture('ws-ticker-btcusdt.json');

    expect(parseWsTickerEvent(fixture)).toEqual({
      symbol: 'BTCUSDT',
      markPrice: 65000.5,
      openInterestValue: 123456789.01,
      ts: 1739942400123,
      lastPrice: null,
      bid: null,
      ask: null,
      spreadBps: null,
      lastTickTs: 1739942400123
    });
  });

  it('returns null for ws ticker event when markPrice is not numeric', () => {
    const fixture = readFixture('ws-ticker-btcusdt.json') as {
      data: { markPrice: string };
    };
    fixture.data.markPrice = 'not-a-number';

    expect(parseWsTickerEvent(fixture)).toBeNull();
  });

  it('parses instruments-info fixture lot size fields', () => {
    const fixture = readFixture('instruments-info-linear.json');

    expect(parseInstrumentsInfo(fixture)).toEqual([
      {
        symbol: 'BTCUSDT',
        category: 'linear',
        contractType: 'LinearPerpetual',
        status: 'Trading',
        settleCoin: 'USDT',
        quoteCoin: 'USDT',
        baseCoin: 'BTC',
        deliveryTime: null,
        qtyStep: 0.001,
        minOrderQty: 0.001,
        maxOrderQty: 100
      }
    ]);
  });

  it('returns empty instruments list when rows are missing symbol', () => {
    expect(
      parseInstrumentsInfo({
        result: {
          list: [{ lotSizeFilter: { qtyStep: '0.001', minOrderQty: '0.001' } }]
        }
      })
    ).toEqual([]);
  });

  it('parses open orders fixture fields used by demo engine', () => {
    const fixture = readFixture('order-realtime-open.json');

    expect(parseOpenOrders(fixture)).toEqual([
      {
        symbol: 'BTCUSDT',
        orderId: '8f6fcb45-0ae2-4cad-9b2e-df5b6e45318d',
        orderLinkId: 'demo-order-001',
        orderStatus: 'New'
      }
    ]);
  });

  it('returns empty open orders when list payload is invalid', () => {
    expect(parseOpenOrders({ result: { list: [null] } })).toEqual([]);
  });

  it('parses position list fixture into normalized numeric values', () => {
    const fixture = readFixture('position-list-linear.json');

    expect(parsePositions(fixture)).toEqual([
      {
        symbol: 'BTCUSDT',
        size: 0.01,
        entryPrice: 65010.5,
        side: 'Buy',
        positionIdx: 1,
        leverage: 10,
        unrealisedPnl: 12.34
      }
    ]);
  });

  it('returns empty positions when symbol is missing', () => {
    expect(
      parsePositions({
        result: {
          list: [{ size: '0.010', avgPrice: '65010.5' }]
        }
      })
    ).toEqual([]);
  });
});

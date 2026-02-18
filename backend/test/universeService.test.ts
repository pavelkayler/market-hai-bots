import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FastifyBaseLogger } from 'fastify';

import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from '../src/services/bybitMarketClient.js';
import { ActiveSymbolSet, UniverseService } from '../src/services/universeService.js';

class FixtureMarketClient implements IBybitMarketClient {
  constructor(
    private readonly instruments: InstrumentLinear[],
    private readonly tickers: Map<string, TickerLinear>
  ) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    return this.instruments;
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    return this.tickers;
  }

  async getTickerLinear(symbol: string): Promise<TickerLinear | null> {
    return this.tickers.get(symbol) ?? null;
  }
}

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  child: () => logger
} as unknown as FastifyBaseLogger;

const makeInstrument = (overrides: Partial<InstrumentLinear>): InstrumentLinear => ({
  symbol: 'BTCUSDT',
  category: 'linear',
  contractType: 'PERPETUAL',
  status: 'Trading',
  settleCoin: 'USDT',
  quoteCoin: 'USDT',
  baseCoin: 'BTC',
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 100,
  ...overrides
});

const makeTicker = (symbol: string, overrides: Partial<TickerLinear> = {}): TickerLinear => ({
  symbol,
  turnover24hUSDT: 20_000_000,
  turnover24h: 20_000_000,
  highPrice24h: 120,
  lowPrice24h: 100,
  markPrice: 110,
  openInterestValue: 100_000,
  ...overrides
});

describe('UniverseService diagnostics and matching', () => {
  it('all excluded by contract filter only when fixture has no valid perps', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-service-'));
    const service = new UniverseService(
      new FixtureMarketClient(
        [
          makeInstrument({ symbol: 'BTCUSDT-26JUN26', contractType: 'FUTURES', deliveryTime: '1782345600000' }),
          makeInstrument({ symbol: 'BTCUSD', category: 'inverse', quoteCoin: 'USD', settleCoin: 'BTC' })
        ],
        new Map([
          ['BTCUSDT-26JUN26', makeTicker('BTCUSDT-26JUN26')],
          ['BTCUSD', makeTicker('BTCUSD')]
        ])
      ),
      new ActiveSymbolSet(),
      logger,
      path.join(tempDir, 'universe.json')
    );

    const result = await service.create(5, 5_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.symbols).toEqual([]);
    expect(result.state.diagnostics?.excluded.expiring).toBe(1);
    expect(result.state.diagnostics?.excluded.nonLinear).toBe(1);
    expect(result.state.diagnostics?.excluded.tickerMissing).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('ticker mismatch increments tickerMissing and keeps valid list empty', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-service-'));
    const service = new UniverseService(
      new FixtureMarketClient(
        [makeInstrument({ symbol: 'ETHUSDT' })],
        new Map([
          ['ETH-USDT', makeTicker('ETH-USDT')]
        ])
      ),
      new ActiveSymbolSet(),
      logger,
      path.join(tempDir, 'universe.json')
    );

    const result = await service.create(5, 5_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.symbols).toEqual([]);
    expect(result.state.diagnostics?.excluded.tickerMissing).toBe(1);
    expect(result.state.filteredOut?.dataUnavailable).toBe(1);

    await rm(tempDir, { recursive: true, force: true });
  });


  it('includes perpetual variants and excludes expiring futures in one build', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-service-'));
    const service = new UniverseService(
      new FixtureMarketClient(
        [
          makeInstrument({ symbol: 'BTCUSDT', contractType: 'PERPETUAL', deliveryTime: null }),
          makeInstrument({ symbol: 'ETHUSDT', contractType: 'LinearPerpetual', deliveryTime: '' }),
          makeInstrument({ symbol: 'SOLUSDT', contractType: null, deliveryTime: null }),
          makeInstrument({ symbol: 'XRPUSDT', contractType: 'LinearFutures', deliveryTime: '1782345600000' }),
          makeInstrument({ symbol: 'BTCUSDT-26JUN26', contractType: '', deliveryTime: '0' })
        ],
        new Map([
          ['BTCUSDT', makeTicker('BTCUSDT')],
          ['ETHUSDT', makeTicker('ETHUSDT')],
          ['SOLUSDT', makeTicker('SOLUSDT')],
          ['XRPUSDT', makeTicker('XRPUSDT')],
          ['BTCUSDT-26JUN26', makeTicker('BTCUSDT-26JUN26')]
        ])
      ),
      new ActiveSymbolSet(),
      logger,
      path.join(tempDir, 'universe.json')
    );

    const result = await service.create(5, 5_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.state.symbols.map((entry) => entry.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(result.state.diagnostics?.excluded.expiring).toBe(2);
    expect(result.state.diagnostics?.excluded.nonPerp).toBe(0);
    expect(result.state.diagnostics?.excluded.tickerMissing).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('valid perps produce non-zero symbols and consistent sums', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'universe-service-'));
    const service = new UniverseService(
      new FixtureMarketClient(
        [
          makeInstrument({ symbol: 'BTCUSDT' }),
          makeInstrument({ symbol: 'ETHUSDT' }),
          makeInstrument({ symbol: 'XRPUSDT' })
        ],
        new Map([
          ['BTCUSDT', makeTicker('BTCUSDT')],
          ['ETHUSDT', makeTicker('ETHUSDT', { turnover24hUSDT: 1_000_000, turnover24h: 1_000_000 })],
          ['XRPUSDT', makeTicker('XRPUSDT')]
        ])
      ),
      new ActiveSymbolSet(),
      logger,
      path.join(tempDir, 'universe.json')
    );

    const result = await service.create(5, 5_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const diagnostics = result.state.diagnostics!;
    expect(result.state.symbols.length).toBeGreaterThan(0);
    expect(diagnostics.totals.instrumentsTotal).toBe(3);
    expect(diagnostics.totals.matchedTotal).toBe(3);
    expect(diagnostics.totals.validTotal).toBe(result.state.symbols.length);

    const contractFiltered =
      diagnostics.excluded.nonPerp +
      diagnostics.excluded.expiring +
      diagnostics.excluded.nonLinear +
      diagnostics.excluded.nonTrading +
      diagnostics.excluded.nonUSDT +
      diagnostics.excluded.unknown;

    const candidateCount = diagnostics.totals.instrumentsTotal - contractFiltered;
    expect(candidateCount).toBe(diagnostics.totals.matchedTotal + diagnostics.excluded.tickerMissing);
    expect(diagnostics.totals.matchedTotal).toBe(
      diagnostics.totals.validTotal + diagnostics.excluded.thresholdFiltered + diagnostics.excluded.parseError
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});

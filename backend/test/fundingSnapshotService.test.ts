import { describe, expect, it } from 'vitest';

import { FundingSnapshotService, classifyFundingSnapshot } from '../src/market/fundingSnapshotService.js';
import type { TickerLinear } from '../src/services/bybitMarketClient.js';

class StubFundingClient {
  constructor(private readonly handler: (symbol: string) => Promise<TickerLinear | null>) {}

  async getTickerLinear(symbol: string): Promise<TickerLinear | null> {
    return this.handler(symbol);
  }
}

describe('FundingSnapshotService', () => {
  it('refreshes all tracked symbols with per-symbol best-effort behavior', async () => {
    const calls: string[] = [];
    const service = new FundingSnapshotService();
    service.init({
      bybitClient: new StubFundingClient(async (symbol) => {
        calls.push(symbol);
        if (symbol === 'FAILUSDT') {
          throw new Error('upstream failed');
        }

        return {
          symbol,
          turnover24hUSDT: null,
          turnover24h: null,
          highPrice24h: null,
          lowPrice24h: null,
          markPrice: null,
          openInterestValue: null,
          fundingRate: symbol === 'BTCUSDT' ? 0.001 : 0.002,
          nextFundingTime: 1_700_000_000_000
        };
      }),
      universeProvider: { getSymbols: () => ['BTCUSDT', 'ETHUSDT', 'FAILUSDT'] },
      logger: { info: () => undefined, warn: () => undefined } as any
    });

    await service.refreshNowBestEffort('test');

    expect(calls.sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'FAILUSDT']);
    expect(service.get('BTCUSDT')?.fundingRate).toBe(0.001);
    expect(service.get('ETHUSDT')?.fundingRate).toBe(0.002);
    expect(service.get('FAILUSDT')).toBeNull();
  });

  it('keeps previous good cache when single symbol fetch fails', async () => {
    const answers = new Map<string, TickerLinear | Error>([
      [
        'BTCUSDT',
        {
          symbol: 'BTCUSDT',
          turnover24hUSDT: null,
          turnover24h: null,
          highPrice24h: null,
          lowPrice24h: null,
          markPrice: null,
          openInterestValue: null,
          fundingRate: 0.003,
          nextFundingTime: 1_700_000_000_000
        }
      ]
    ]);

    const service = new FundingSnapshotService();
    service.init({
      bybitClient: new StubFundingClient(async (symbol) => {
        const value = answers.get(symbol);
        if (value instanceof Error) {
          throw value;
        }
        return value ?? null;
      }),
      universeProvider: { getSymbols: () => ['BTCUSDT'] },
      logger: { info: () => undefined, warn: () => undefined } as any
    });

    await service.refreshNowBestEffort('initial');
    const first = service.get('BTCUSDT');
    expect(first?.fundingRate).toBe(0.003);

    answers.set('BTCUSDT', new Error('temporary failure'));
    await service.refreshNowBestEffort('second');

    const second = service.get('BTCUSDT');
    expect(second?.fundingRate).toBe(0.003);
    expect(second?.fetchedAtMs).toBe(first?.fetchedAtMs);
  });

  it('classifies stale snapshots deterministically', () => {
    const now = 1_700_000_000_000;
    const classified = classifyFundingSnapshot(
      {
        fundingRate: 0.01,
        nextFundingTimeMs: now + 60_000,
        fetchedAtMs: now - 700_000,
        source: 'REST_TICKERS'
      },
      now
    );

    expect(classified.fundingStatus).toBe('STALE');
    expect(classified.fundingRate).toBeNull();
  });
});

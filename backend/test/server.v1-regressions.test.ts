import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDefaultBotConfig } from '../src/bot/botEngine.js';
import { buildServer, getMarketHub } from '../src/server.js';
import type { IBybitMarketClient, InstrumentLinear, TickerLinear } from '../src/services/bybitMarketClient.js';

class FakeMarketClient implements IBybitMarketClient {
  constructor(
    private readonly instruments: InstrumentLinear[],
    private readonly tickers: Map<string, TickerLinear>
  ) {}

  async getInstrumentsLinearAll(): Promise<InstrumentLinear[]> {
    return this.instruments.map((instrument) => ({
      category: instrument.category ?? 'linear',
      status: instrument.status ?? 'Trading',
      settleCoin: instrument.settleCoin ?? 'USDT',
      quoteCoin: instrument.quoteCoin ?? 'USDT',
      ...instrument
    }));
  }

  async getTickersLinear(): Promise<Map<string, TickerLinear>> {
    return this.tickers;
  }

  async getTickerLinear(symbol: string): Promise<TickerLinear | null> {
    return this.tickers.get(symbol) ?? null;
  }
}

describe('v1 regressions', () => {
  const originalCwd = process.cwd();
  let tmpDir: string | null = null;

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  const withIsolatedServer = async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'v1-regression-'));
    await mkdir(path.join(tmpDir, 'data'), { recursive: true });
    await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }), 'utf-8');
    process.chdir(tmpDir);

    const app = buildServer({
      marketClient: new FakeMarketClient(
        [{ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, maxOrderQty: 100 }],
        new Map([
          [
            'BTCUSDT',
            {
              symbol: 'BTCUSDT',
              turnover24h: 12_000_000,
              highPrice24h: 41_000,
              lowPrice24h: 39_000,
              fundingRate: '0.0002',
              nextFundingTime: String(Date.now() + 60_000)
            }
          ]
        ])
      )
    });

    await app.ready();
    return app;
  };

  it('default bot config is non-null', () => {
    const defaults = getDefaultBotConfig();
    expect(defaults.mode).toBe('paper');
    expect(defaults.direction).toBe('both');
    expect(defaults.marginUSDT).toBeGreaterThan(0);
  });

  it('POST /api/bot/config accepts partial payload and persists required fields', async () => {
    const app = await withIsolatedServer();

    const saveResponse = await app.inject({
      method: 'POST',
      url: '/api/bot/config',
      payload: { tfMinutes: 1, priceUpThrPct: 0.001, oiUpThrPct: 0.001, minTriggerCount: 2, maxTriggerCount: 3, minFundingAbs: 0 }
    });

    expect(saveResponse.statusCode).toBe(200);
    const saveJson = saveResponse.json() as { ok: boolean; config: Record<string, unknown> };
    expect(saveJson.ok).toBe(true);
    expect(saveJson.config.mode).toBe('paper');
    expect(saveJson.config.direction).toBe('both');
    expect(saveJson.config.marginUSDT).toBeGreaterThan(0);
    expect(saveJson.config.leverage).toBeGreaterThan(0);
    expect(saveJson.config.tpRoiPct).toBeGreaterThan(0);
    expect(saveJson.config.slRoiPct).toBeGreaterThan(0);

    const getResponse = await app.inject({ method: 'GET', url: '/api/bot/config' });
    expect(getResponse.statusCode).toBe(200);
    const getJson = getResponse.json() as { ok: boolean; config: Record<string, unknown> };
    expect(getJson.ok).toBe(true);
    expect(getJson.config.priceUpThrPct).toBe(0.001);

    const persisted = JSON.parse(await readFile(path.join(tmpDir!, 'data/botConfig.json'), 'utf-8')) as Record<string, unknown>;
    expect(persisted.mode).toBe('paper');

    await app.close();
  });

  it('POST /api/bot/start returns 409 when universe missing and 200 when universe is ready', async () => {
    const app = await withIsolatedServer();

    const missingUniverse = await app.inject({ method: 'POST', url: '/api/bot/start', payload: {} });
    expect(missingUniverse.statusCode).toBe(409);
    expect(missingUniverse.json()).toEqual({ ok: false, error: 'UNIVERSE_NOT_READY' });

    await app.inject({ method: 'POST', url: '/api/universe/create', payload: { minVolPct: 0, minTurnover: 1 } });
    await getMarketHub(app).start();
    const startResponse = await app.inject({ method: 'POST', url: '/api/bot/start', payload: {} });
    expect(startResponse.statusCode).toBe(200);
    expect((startResponse.json() as { ok?: boolean }).ok).toBe(true);

    await app.close();
  });
});

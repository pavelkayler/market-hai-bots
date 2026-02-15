import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('server routes', () => {
  let app = buildServer();

  afterEach(async () => {
    await app.close();
    app = buildServer();
  });

  it('GET /health returns ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('GET /api/bot/state returns initial bot state', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bot/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      running: false,
      mode: null,
      direction: null,
      tf: null,
      queueDepth: 0,
      activeOrders: 0,
      openPositions: 0
    });
  });
});

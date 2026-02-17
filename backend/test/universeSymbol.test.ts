import { describe, expect, it } from 'vitest';

import { normalizeUniverseSymbol } from '../src/services/universeSymbol.js';

describe('normalizeUniverseSymbol', () => {
  it('normalizes case and trims without changing symbol identity', () => {
    expect(normalizeUniverseSymbol(' btcusdt ')).toBe('BTCUSDT');
    expect(normalizeUniverseSymbol('BTCUSDT-26JUN26')).toBe('BTCUSDT-26JUN26');
  });

  it('returns null for empty or non-string values', () => {
    expect(normalizeUniverseSymbol('   ')).toBeNull();
    expect(normalizeUniverseSymbol(null)).toBeNull();
    expect(normalizeUniverseSymbol(undefined)).toBeNull();
  });
});

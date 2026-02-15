import { describe, expect, it } from 'vitest';

import { normalizeQty } from '../src/utils/qty.js';

describe('normalizeQty', () => {
  it('floors raw qty to qtyStep', () => {
    expect(normalizeQty(1.234, 0.01, 0.01, null)).toBe(1.23);
  });

  it('returns null when normalized qty is below minOrderQty', () => {
    expect(normalizeQty(0.099, 0.01, 0.1, null)).toBeNull();
  });

  it('clamps to maxOrderQty and step-normalizes again', () => {
    expect(normalizeQty(10.08, 0.1, 0.1, 10.05)).toBe(10);
  });
});

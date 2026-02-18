const UINT32 = 0x1_0000_0000;

export const mixSeed32 = (...parts: number[]): number => {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const value = Number.isFinite(part) ? Math.floor(part) : 0;
    hash ^= value >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const createDeterministicRng = (seed: number): (() => number) => {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / UINT32;
  };
};

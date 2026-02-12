export function createPullbackTest() {
  return {
    start: () => ({ ok: false, reason: 'removed' }),
    stop: () => ({ ok: true }),
    getState: () => ({ status: 'REMOVED' }),
  };
}

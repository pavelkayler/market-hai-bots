const baseUrl = process.env.RC_SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';

const getJson = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.json();
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const requiredStateKeys = ['bot', 'config', 'universe', 'activity', 'symbols'];

const run = async () => {
  const doctor = await getJson('/api/doctor');
  assert(typeof doctor === 'object' && doctor !== null, 'doctor payload must be object');
  assert(Array.isArray(doctor.checks), 'doctor.checks must be array');
  assert(doctor.ok === true, 'doctor overall status must be PASS (ok=true)');

  const state = await getJson('/api/bot/state');
  assert(typeof state === 'object' && state !== null, 'state payload must be object');
  for (const key of requiredStateKeys) {
    assert(Object.hasOwn(state, key), `state missing key: ${key}`);
  }

  const activity = state.activity ?? {};
  for (const key of ['queueDepth', 'activeOrders', 'openPositions', 'symbolUpdatesPerSec', 'journalAgeMs']) {
    assert(Number.isFinite(activity[key]), `state.activity.${key} must be finite number`);
  }

  const symbols = Array.isArray(state.symbols) ? state.symbols : [];
  for (const symbolState of symbols) {
    for (const key of ['symbol', 'markPrice', 'openInterestValue', 'priceDeltaPct', 'oiDeltaPct', 'signalCount24h']) {
      assert(Object.hasOwn(symbolState, key), `symbol row missing key: ${key}`);
    }
    assert(Object.hasOwn(symbolState, 'fundingRate'), 'symbol row missing fundingRate');
    assert(Object.hasOwn(symbolState, 'nextFundingTimeMs'), 'symbol row missing nextFundingTimeMs');
    assert(Object.hasOwn(symbolState, 'timeToFundingMs'), 'symbol row missing timeToFundingMs');
  }

  console.log('RC smoke PASS');
  console.log(`doctor checks=${doctor.checks.length}, symbols=${symbols.length}, queueDepth=${activity.queueDepth}`);
};

run().catch((error) => {
  console.error(`RC smoke FAIL: ${error.message}`);
  process.exitCode = 1;
});

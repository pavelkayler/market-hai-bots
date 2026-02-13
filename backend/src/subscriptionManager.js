function normSym(sym) {
  const s = String(sym || '').trim().toUpperCase().replace(/[\/-]/g, '');
  return s || null;
}

function keyFor(stream, symbol) {
  return `BYBIT:${stream}:${symbol}`;
}

export function createSubscriptionManager({ bybit, logger = console } = {}) {
  const refs = new Map();
  const ownerKeys = new Map();

  function toIntentKeys({ symbols = [], streamType = 'ticker', streams, needsOi = false } = {}) {
    const next = new Set();
    const streamList = Array.isArray(streams) && streams.length ? streams : [streamType || 'ticker'];
    for (const symbolRaw of symbols) {
      const symbol = normSym(symbolRaw);
      if (!symbol) continue;
      for (const stream of streamList) next.add(keyFor(stream, symbol));
      if (needsOi) next.add(keyFor('oi', symbol));
    }
    return next;
  }

  function recomputeSymbols() {
    const bybitSymbols = new Set();
    for (const [key, count] of refs.entries()) {
      if (count <= 0) continue;
      const [_source, _stream, symbol] = key.split(':');
      if (symbol) bybitSymbols.add(symbol);
    }
    bybit.setSymbols([...bybitSymbols]);
  }

  function replaceIntent(owner, { symbols = [], streamType = 'ticker', streams, needsOi = false } = {}) {
    const id = String(owner || 'unknown');
    const current = ownerKeys.get(id) || new Set();
    const next = toIntentKeys({ symbols, streamType, streams, needsOi });

    for (const key of current) {
      if (next.has(key)) continue;
      const prev = Number(refs.get(key) || 0);
      if (prev <= 1) refs.delete(key);
      else refs.set(key, prev - 1);
    }
    for (const key of next) {
      if (current.has(key)) continue;
      refs.set(key, Number(refs.get(key) || 0) + 1);
    }

    ownerKeys.set(id, next);
    recomputeSymbols();
    logger?.info?.({ owner: id, refs: refs.size }, '[subs] replaceIntent');
    return { owner: id, keys: [...next] };
  }

  function addIntent(owner, symbols = [], streamType = 'ticker') {
    const id = String(owner || 'unknown');
    const current = ownerKeys.get(id) || new Set();
    const next = new Set(current);
    const add = toIntentKeys({ symbols, streamType });
    for (const key of add) {
      if (next.has(key)) continue;
      next.add(key);
      refs.set(key, Number(refs.get(key) || 0) + 1);
    }
    ownerKeys.set(id, next);
    recomputeSymbols();
    logger?.info?.({ owner: id, refs: refs.size }, '[subs] addIntent');
    return { owner: id, keys: [...next] };
  }

  function requestFeed(owner, { bybitSymbols = [], streams = ['ticker'], needsOi = false } = {}) {
    return replaceIntent(owner, { symbols: bybitSymbols, streams, needsOi });
  }

  function releaseFeed(owner) {
    const id = String(owner || 'unknown');
    const current = ownerKeys.get(id);
    if (!current) return { owner: id, released: 0 };
    for (const key of current) {
      const prev = Number(refs.get(key) || 0);
      if (prev <= 1) refs.delete(key);
      else refs.set(key, prev - 1);
    }
    ownerKeys.delete(id);
    recomputeSymbols();
    logger?.info?.({ owner: id, refs: refs.size }, '[subs] releaseFeed');
    return { owner: id, released: current.size };
  }

  function removeIntent(owner) {
    return releaseFeed(owner);
  }

  function getState() {
    return {
      refs: Object.fromEntries(refs.entries()),
      owners: Object.fromEntries([...ownerKeys.entries()].map(([k, v]) => [k, [...v]])),
      bybitSymbols: bybit.getSymbols(),
    };
  }

  return { requestFeed, releaseFeed, addIntent, removeIntent, replaceIntent, getState };
}

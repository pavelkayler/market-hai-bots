function normSym(sym) {
  const s = String(sym || '').trim().toUpperCase().replace(/[\/-]/g, '');
  return s || null;
}

function keyFor(source, stream, symbol) {
  return `${source}:${stream}:${symbol}`;
}

export function createSubscriptionManager({ bybit, binance, logger = console } = {}) {
  const refs = new Map();
  const ownerKeys = new Map();

  function recomputeSymbols() {
    const bybitSymbols = new Set();
    const binanceSymbols = new Set();
    for (const [key, count] of refs.entries()) {
      if (count <= 0) continue;
      const [source, _stream, symbol] = key.split(':');
      if (!symbol) continue;
      if (source === 'BYBIT') bybitSymbols.add(symbol);
      if (source === 'BINANCE') binanceSymbols.add(symbol);
    }
    bybit.setSymbols([...bybitSymbols]);
    binance.setSymbols([...binanceSymbols]);
  }

  function requestFeed(owner, { bybitSymbols = [], binanceSymbols = [], streams = ['ticker'], needsOi = false } = {}) {
    const id = String(owner || 'unknown');
    const current = ownerKeys.get(id) || new Set();

    const next = new Set();
    const streamList = Array.isArray(streams) && streams.length ? streams : ['ticker'];
    for (const symbolRaw of bybitSymbols) {
      const symbol = normSym(symbolRaw);
      if (!symbol) continue;
      for (const stream of streamList) next.add(keyFor('BYBIT', stream, symbol));
      if (needsOi) next.add(keyFor('BYBIT', 'oi', symbol));
    }
    for (const symbolRaw of binanceSymbols) {
      const symbol = normSym(symbolRaw);
      if (!symbol) continue;
      for (const stream of streamList) next.add(keyFor('BINANCE', stream, symbol));
    }

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
    logger?.info?.({ owner: id, refs: refs.size }, '[subs] requestFeed');
    return { owner: id, keys: [...next] };
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

  function getState() {
    return {
      refs: Object.fromEntries(refs.entries()),
      owners: Object.fromEntries([...ownerKeys.entries()].map(([k, v]) => [k, [...v]])),
      bybitSymbols: bybit.getSymbols(),
      binanceSymbols: binance.getSymbols(),
    };
  }

  return { requestFeed, releaseFeed, getState };
}

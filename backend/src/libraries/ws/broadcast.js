export function createWsBroadcaster() {
  const clients = new Set();
  const wsTopics = new Map();

  const send = (ws, payload) => {
    try { ws.send(JSON.stringify(payload)); } catch {}
  };

  const subscribed = (ws, topic) => {
    const filters = wsTopics.get(ws) || new Set(['*']);
    for (const filter of filters) {
      if (filter === '*' || filter === topic || (filter.endsWith('.*') && topic.startsWith(filter.slice(0, -1)))) return true;
    }
    return false;
  };

  return {
    addClient(ws) {
      clients.add(ws);
      wsTopics.set(ws, new Set(['*']));
    },
    removeClient(ws) {
      clients.delete(ws);
      wsTopics.delete(ws);
    },
    subscribe(ws, topics = []) {
      const next = new Set((topics || []).filter((x) => typeof x === 'string'));
      wsTopics.set(ws, next.size ? next : new Set(['*']));
    },
    unsubscribe(ws) {
      wsTopics.set(ws, new Set(['*']));
    },
    send,
    broadcastEvent(topic, payload) {
      for (const ws of clients) if (subscribed(ws, topic)) send(ws, { type: 'event', topic, payload });
    },
  };
}

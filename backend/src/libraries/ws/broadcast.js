export function createWsBroadcast() {
  const clients = new Set();
  const wsTopics = new Map();

  const send = (ws, payload) => {
    try { ws.send(JSON.stringify(payload)); } catch {}
  };

  const subscribed = (ws, topic) => {
    const filters = wsTopics.get(ws) || new Set(['*']);
    for (const f of filters) {
      if (f === '*' || f === topic || (f.endsWith('.*') && topic.startsWith(f.slice(0, -1)))) return true;
    }
    return false;
  };

  const broadcastEvent = (topic, payload) => {
    for (const ws of clients) if (subscribed(ws, topic)) send(ws, { type: 'event', topic, payload });
  };

  return {
    send,
    broadcastEvent,
    onOpen(ws) {
      clients.add(ws);
      wsTopics.set(ws, new Set(['*']));
    },
    onClose(ws) {
      clients.delete(ws);
      wsTopics.delete(ws);
    },
    subscribeTopics(ws, topics = []) {
      const next = new Set((topics || []).filter((x) => typeof x === 'string'));
      wsTopics.set(ws, next.size ? next : new Set(['*']));
    },
    resetTopics(ws) {
      wsTopics.set(ws, new Set(['*']));
    },
  };
}

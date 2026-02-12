export function toWsUrl(apiBase) {
  const u = new URL(apiBase);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${u.host}/ws`;
}

export function createManagedWebSocket(wsUrl, handlers = {}, opts = {}) {
  const ws = new WebSocket(wsUrl);
  let shouldClose = false;

  ws.onopen = (event) => {
    if (shouldClose) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'cleanup');
      return;
    }
    handlers.onOpen?.(event, ws);
  };

  ws.onmessage = (event) => {
    if (!shouldClose) handlers.onMessage?.(event, ws);
  };

  ws.onerror = (event) => {
    if (!shouldClose) handlers.onError?.(event, ws);
  };

  ws.onclose = (event) => {
    handlers.onClose?.(event, ws);
  };

  return {
    ws,
    close() {
      shouldClose = true;
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, opts.reason || 'cleanup');
    },
    shouldClose: () => shouldClose,
  };
}

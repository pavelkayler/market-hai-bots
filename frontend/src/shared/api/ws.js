import { createContext, createElement, useContext, useEffect, useMemo, useState } from "react";

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const WsContext = createContext(null);

export function toWsUrl(apiBase = DEFAULT_API_BASE) {
  const u = new URL(apiBase);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws`;
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createWsManager(
  wsUrl,
  {
    onMessage,
    heartbeatMs = 18000,
    initialBackoffMs = 500,
    maxBackoffMs = 10000,
    outboxLimit = 200,
  } = {},
) {
  let ws = null;
  let manualClose = false;
  let shouldCloseAfterConnect = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastPongAt = Date.now();
  let backoffMs = initialBackoffMs;
  let status = "idle";
  const outbox = [];
  const rpcPending = new Map();
  let rpcSeq = 1;

  const listeners = new Set();
  const statusListeners = new Set();

  const notifyStatus = (next) => {
    status = next;
    for (const fn of statusListeners) fn(next);
  };

  const cleanupSocket = () => {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws = null;
  };

  const stopHeartbeat = () => {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const scheduleReconnect = () => {
    if (manualClose || reconnectTimer) return;
    notifyStatus("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(maxBackoffMs, Math.round(backoffMs * 1.8));
  };

  const handleMessage = (event) => {
    const parsed = parseJsonSafe(event.data);
    if (parsed?.type === "pong" || parsed?.topic === "pong") {
      lastPongAt = Date.now();
      return;
    }

    if (parsed && Object.prototype.hasOwnProperty.call(parsed, "id") && rpcPending.has(parsed.id)) {
      const resolver = rpcPending.get(parsed.id);
      rpcPending.delete(parsed.id);
      resolver(parsed);
      return;
    }

    onMessage?.(event, parsed);
    for (const fn of listeners) fn(event, parsed);
  };

  const flushOutbox = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !outbox.length) return;
    while (outbox.length) {
      const raw = outbox.shift();
      try {
        ws.send(raw);
      } catch {
        outbox.unshift(raw);
        break;
      }
    }
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > heartbeatMs * 3) {
        try {
          ws.close(4000, "heartbeat timeout");
        } catch {
          // noop
        }
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      } catch {
        // noop
      }
    }, heartbeatMs);
  };

  const connect = () => {
    if (manualClose) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    notifyStatus("connecting");
    const next = new WebSocket(wsUrl);
    ws = next;

    next.onopen = () => {
      if (next !== ws) return;
      if (shouldCloseAfterConnect) {
        shouldCloseAfterConnect = false;
        closeSocketSafely(next, 1000, "deferred close after connect");
        return;
      }
      backoffMs = initialBackoffMs;
      lastPongAt = Date.now();
      notifyStatus("connected");
      sendJson({ type: "ping", ts: Date.now() });
      flushOutbox();
      startHeartbeat();
    };

    next.onmessage = handleMessage;

    next.onerror = () => {
      if (next !== ws) return;
      notifyStatus("error");
    };

    next.onclose = () => {
      if (next !== ws) return;
      stopHeartbeat();
      cleanupSocket();
      if (!manualClose) scheduleReconnect();
      else notifyStatus("closed");
    };
  };

  const closeSocketSafely = (target, code = 1000, reason = "cleanup") => {
    if (!target) return;
    if (target.readyState === WebSocket.CLOSING || target.readyState === WebSocket.CLOSED) return;
    if (target.readyState === WebSocket.CONNECTING) {
      shouldCloseAfterConnect = true;
      return;
    }
    try {
      target.close(code, reason);
    } catch {
      // noop
    }
  };

  connect();

  const sendJson = (payload) => {
    const raw = JSON.stringify(payload);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (outbox.length >= outboxLimit) outbox.shift();
      outbox.push(raw);
      return true;
    }
    ws.send(raw);
    return true;
  };

  const request = (method, params = {}) => new Promise((resolve) => {
    const id = `rpc_${Date.now()}_${rpcSeq++}`;
    rpcPending.set(id, (payload) => resolve(payload?.result));
    sendJson({ id, method, params });
    setTimeout(() => {
      if (!rpcPending.has(id)) return;
      rpcPending.delete(id);
      resolve(null);
    }, 10000);
  });

  return {
    get wsUrl() {
      return wsUrl;
    },
    getStatus() {
      return status;
    },
    sendJson,
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    request,
    subscribeTopics(topics = []) {
      return sendJson({ type: "ui.subscribe", payload: { topics } });
    },
    unsubscribeTopics(topics = []) {
      return sendJson({ type: "ui.unsubscribe", payload: { topics } });
    },
    subscribeStatus(handler) {
      statusListeners.add(handler);
      handler(status);
      return () => statusListeners.delete(handler);
    },
    reconnect() {
      if (manualClose) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      closeSocketSafely(ws, 4001, "manual reconnect");
      scheduleReconnect();
    },
    close() {
      manualClose = true;
      shouldCloseAfterConnect = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopHeartbeat();
      closeSocketSafely(ws, 1000, "app shutdown");
      cleanupSocket();
      notifyStatus("closed");
    },
  };
}

const managerRegistry = new Map();

function getManagerEntry(wsUrl) {
  let entry = managerRegistry.get(wsUrl);
  if (!entry) {
    entry = { manager: createWsManager(wsUrl), refs: 0, cleanupTimer: null };
    managerRegistry.set(wsUrl, entry);
  }
  return entry;
}

function retainManager(wsUrl) {
  const entry = getManagerEntry(wsUrl);
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = null;
  }
  entry.refs += 1;
  return entry.manager;
}

function releaseManager(wsUrl) {
  const entry = managerRegistry.get(wsUrl);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.cleanupTimer) return;
  entry.cleanupTimer = setTimeout(() => {
    const latest = managerRegistry.get(wsUrl);
    if (!latest || latest.refs > 0) return;
    latest.manager.close();
    managerRegistry.delete(wsUrl);
  }, 300);
}

export function WsProvider({ children, apiBase = DEFAULT_API_BASE }) {
  const wsUrl = useMemo(() => toWsUrl(apiBase), [apiBase]);
  const manager = useMemo(() => retainManager(wsUrl), [wsUrl]);

  useEffect(() => {
    return () => releaseManager(wsUrl);
  }, [wsUrl]);

  return createElement(WsContext.Provider, { value: manager }, children);
}

export function useWs() {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error("useWs must be used inside WsProvider");
  return ctx;
}

export function useWsClient({ onMessage, onOpen } = {}) {
  const manager = useWs();
  const [status, setStatus] = useState(() => manager.getStatus());

  useEffect(() => manager.subscribeStatus(setStatus), [manager]);

  useEffect(() => {
    if (!onMessage) return undefined;
    return manager.subscribe((event, parsed) => onMessage(event, parsed));
  }, [manager, onMessage]);

  useEffect(() => {
    if (status === "connected") onOpen?.();
  }, [status, onOpen]);

  return {
    wsUrl: manager.wsUrl,
    status,
    sendJson: manager.sendJson,
    reconnect: manager.reconnect,
    subscribe: manager.subscribe,
    request: manager.request,
    subscribeTopics: manager.subscribeTopics,
    unsubscribeTopics: manager.unsubscribeTopics,
  };
}

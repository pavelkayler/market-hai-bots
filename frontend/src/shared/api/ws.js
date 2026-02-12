import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from "react";

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
  } = {},
) {
  let ws = null;
  let manualClose = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let lastPongAt = Date.now();
  let backoffMs = initialBackoffMs;
  let status = "idle";

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

    onMessage?.(event, parsed);
    for (const fn of listeners) fn(event, parsed);
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
      backoffMs = initialBackoffMs;
      lastPongAt = Date.now();
      notifyStatus("connected");
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
    try {
      target.close(code, reason);
    } catch {
      // noop
    }
  };

  connect();

  return {
    get wsUrl() {
      return wsUrl;
    },
    getStatus() {
      return status;
    },
    sendJson(payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(payload));
      return true;
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
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

export function WsProvider({ children, apiBase = DEFAULT_API_BASE }) {
  const wsUrl = useMemo(() => toWsUrl(apiBase), [apiBase]);
  const managerRef = useRef(null);

  if (!managerRef.current) {
    managerRef.current = createWsManager(wsUrl);
  }

  useEffect(() => {
    const mgr = managerRef.current;
    return () => mgr?.close();
  }, []);

  return createElement(WsContext.Provider, { value: managerRef.current }, children);
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
    return manager.subscribe((event) => onMessage(event));
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
  };
}

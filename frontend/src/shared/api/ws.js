import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function toWsUrl(apiBase) {
  const u = new URL(apiBase);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws`;
}

export function createManagedWebSocket(wsUrl, handlers = {}, opts = {}) {
  const ws = new WebSocket(wsUrl);
  let shouldClose = false;

  ws.onopen = (event) => {
    if (shouldClose) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, opts.reason || "cleanup");
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
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, opts.reason || "cleanup");
    },
    shouldClose: () => shouldClose,
  };
}

export function useWsClient({ apiBase, onMessage, onOpen, onClose, onError } = {}) {
  const wsUrl = useMemo(() => toWsUrl(apiBase), [apiBase]);
  const managedRef = useRef(null);
  const [status, setStatus] = useState("connecting");

  const callbacksRef = useRef({ onMessage, onOpen, onClose, onError });

  useEffect(() => {
    callbacksRef.current = { onMessage, onOpen, onClose, onError };
  }, [onMessage, onOpen, onClose, onError]);

  const connect = useCallback(() => {
    managedRef.current?.close();
    setStatus("connecting");
    const managed = createManagedWebSocket(wsUrl, {
      onOpen: (event, ws) => {
        setStatus("connected");
        callbacksRef.current.onOpen?.(event, ws);
      },
      onMessage: (event, ws) => {
        callbacksRef.current.onMessage?.(event, ws);
      },
      onClose: (event, ws) => {
        setStatus("disconnected");
        callbacksRef.current.onClose?.(event, ws);
      },
      onError: (event, ws) => {
        setStatus("error");
        callbacksRef.current.onError?.(event, ws);
      },
    });
    managedRef.current = managed;
  }, [wsUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();
    return () => managedRef.current?.close();
  }, [connect]);

  const sendJson = useCallback((obj) => {
    const ws = managedRef.current?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }, []);

  return { wsUrl, status, sendJson, reconnect: connect };
}

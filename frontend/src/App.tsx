import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Container, Nav, Navbar } from 'react-bootstrap';
import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { API_BASE, WS_URL, getBotState, getHealth, getUniverse } from './api';
import type { BotState, QueueUpdatePayload, SymbolUpdatePayload, SymbolsUpdatePayload, UniverseState, WsConnectionState, WsEnvelope } from './types';
import { BotPage } from './pages/BotPage';
import { HomePage } from './pages/HomePage';
import { DoctorPage } from './pages/DoctorPage';

type LogLine = {
  ts: number;
  text: string;
};

function pushLog(current: LogLine[], entry: LogLine): LogLine[] {
  const next = [...current, entry];
  if (next.length <= 5) {
    return next;
  }

  return next.slice(next.length - 5);
}

export function App() {
  const defaultWsState: WsConnectionState = {
    ready: false,
    status: 'DISCONNECTED',
    lastError: null,
    connectedAt: null,
    lastMessageAt: null
  };
  const [restHealthy, setRestHealthy] = useState(false);
  const [wsState, setWsState] = useState<WsConnectionState>(defaultWsState);
  const [botState, setBotState] = useState<BotState>({
    running: false,
    paused: false,
    hasSnapshot: false,
    lastConfig: null,
    mode: null,
    direction: null,
    tf: null,
    queueDepth: 0,
    activeOrders: 0,
    openPositions: 0,
    uptimeMs: 0,
    killInProgress: false,
    killCompletedAt: null,
    killWarning: null
  });
  const [universeState, setUniverseState] = useState<UniverseState>({ ok: false, ready: false });
  const [symbolMap, setSymbolMap] = useState<Record<string, SymbolUpdatePayload>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [symbolUpdatesPerSecond, setSymbolUpdatesPerSecond] = useState(0);
  const reconnectTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolUpdatesInWindowRef = useRef(0);
  const lastStateVersionRef = useRef(0);

  const applyIncomingBotState = useCallback((incoming: BotState, options?: { merge?: boolean }) => {
    const nextVersion = typeof incoming.stateVersion === 'number' && Number.isFinite(incoming.stateVersion) ? incoming.stateVersion : 0;
    if (nextVersion > 0 && nextVersion < lastStateVersionRef.current) {
      return;
    }

    if (nextVersion > lastStateVersionRef.current) {
      lastStateVersionRef.current = nextVersion;
    }

    const merge = options?.merge ?? false;
    if (!merge) {
      setBotState(incoming);
      if (!incoming.running && !incoming.paused) {
        setSymbolMap({});
      }
      return;
    }

    setBotState((prev) => {
      const { paused: _paused, hasSnapshot: _hasSnapshot, lastConfig: _lastConfig, ...allowedPayload } = incoming;
      const safeActivityMetrics = {
        queueDepth: typeof allowedPayload.queueDepth === 'number' && Number.isFinite(allowedPayload.queueDepth) ? allowedPayload.queueDepth : undefined,
        activeOrders: typeof allowedPayload.activeOrders === 'number' && Number.isFinite(allowedPayload.activeOrders) ? allowedPayload.activeOrders : undefined,
        openPositions:
          typeof allowedPayload.openPositions === 'number' && Number.isFinite(allowedPayload.openPositions) ? allowedPayload.openPositions : undefined
      };
      return {
        ...prev,
        ...allowedPayload,
        queueDepth: safeActivityMetrics.queueDepth ?? prev.queueDepth ?? 0,
        activeOrders: safeActivityMetrics.activeOrders ?? prev.activeOrders ?? 0,
        openPositions: safeActivityMetrics.openPositions ?? prev.openPositions ?? 0
      };
    });

    if (incoming.running === false && incoming.paused === false) {
      setSymbolMap({});
    }
  }, []);

  const appendLog = useCallback((text: string, ts?: number) => {
    setLogs((prev) => pushLog(prev, { text, ts: ts ?? Date.now() }));
  }, []);

  const syncRest = useCallback(async () => {
    try {
      const [health, nextUniverse, nextBotState] = await Promise.all([getHealth(), getUniverse(), getBotState()]);
      setRestHealthy(health.ok);
      setUniverseState(nextUniverse);
      applyIncomingBotState(nextBotState);
    } catch {
      setRestHealthy(false);
    }
  }, [applyIncomingBotState]);

  useEffect(() => {
    void syncRest();
    const interval = window.setInterval(() => {
      void getHealth()
        .then((health) => {
          setRestHealthy(health.ok);
        })
        .catch(() => {
          setRestHealthy(false);
        });
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [syncRest]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSymbolUpdatesPerSecond(symbolUpdatesInWindowRef.current);
      symbolUpdatesInWindowRef.current = 0;
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const scheduleReconnect = () => {
      if (reconnectTimer.current !== null) {
        return;
      }

      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, 1500);
    };

    const connect = () => {
      const existing = wsRef.current;
      if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return;
      }

      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }

      setWsState((prev) => ({ ...prev, ready: false, status: 'CONNECTING' }));

      let ws: WebSocket;
      try {
        ws = new WebSocket(WS_URL);
      } catch (error) {
        const message = (error as Error).message;
        setWsState((prev) => ({
          ...prev,
          ready: false,
          status: 'ERROR',
          lastError: message
        }));
        appendLog(`WS connect error: ${message}`);
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState((prev) => ({
          ...prev,
          ready: true,
          status: 'CONNECTED',
          lastError: null,
          connectedAt: Date.now()
        }));
        appendLog('WS connected');
        void syncRest();
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }

        setWsState((prev) => ({
          ...prev,
          ready: false,
          status: prev.status === 'ERROR' ? 'ERROR' : 'DISCONNECTED'
        }));
        appendLog('WS disconnected');
        scheduleReconnect();
      };

      ws.onerror = (event) => {
        const message = event instanceof ErrorEvent ? event.message || 'WebSocket error' : 'WebSocket error';
        setWsState((prev) => ({
          ...prev,
          ready: false,
          status: 'ERROR',
          lastError: message
        }));
        appendLog(`WS error: ${message}`);
        ws.close();
      };

      ws.onmessage = (event) => {
        let message: WsEnvelope;
        try {
          message = JSON.parse(event.data) as WsEnvelope;
        } catch {
          appendLog('WS message parse error');
          return;
        }
        setWsState((prev) => ({ ...prev, lastMessageAt: Date.now() }));

        if (message.type === 'state') {
          applyIncomingBotState(message.payload as BotState, { merge: true });
          return;
        }

        if (message.type === 'symbol:update') {
          const payload = message.payload as SymbolUpdatePayload;
          symbolUpdatesInWindowRef.current += 1;
          setSymbolMap((prev) => ({ ...prev, [payload.symbol]: payload }));
          return;
        }

        if (message.type === 'symbols:update') {
          const payload = message.payload as SymbolsUpdatePayload;
          symbolUpdatesInWindowRef.current += payload.updates.length;
          setSymbolMap((prev) => {
            if (payload.updates.length === 0) {
              return prev;
            }

            const next = { ...prev };
            for (const update of payload.updates) {
              next[update.symbol] = update;
            }

            return next;
          });
          return;
        }

        if (message.type === 'queue:update') {
          const payload = message.payload as QueueUpdatePayload;
          setBotState((prev) => ({ ...prev, queueDepth: payload.depth }));
          return;
        }

        if (message.type === 'universe:created' || message.type === 'universe:refreshed') {
          appendLog(`${message.type} event`);
          void syncRest();
          return;
        }

        if (message.type === 'log') {
          const payload = message.payload as { message?: string };
          if (payload.message) {
            appendLog(payload.message, message.ts);
          }
          return;
        }

        if (message.type === 'order:update' || message.type === 'position:update' || message.type === 'signal:new') {
          appendLog(`${message.type}: ${JSON.stringify(message.payload)}`, message.ts);
        }
      };
    };

    connect();

    return () => {
      if (reconnectTimer.current !== null) {
        window.clearTimeout(reconnectTimer.current);
      }

      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [appendLog, applyIncomingBotState, syncRest]);

  const connectionBadge = useMemo(
    () => (
      <>
        <Badge bg={restHealthy ? 'success' : 'danger'} className="me-2">
          REST {restHealthy ? 'up' : 'down'}
        </Badge>
        <Badge bg={wsState.ready ? 'success' : wsState.status === 'CONNECTING' ? 'warning' : 'danger'}>
          WS {wsState.status.toLowerCase()}
        </Badge>
      </>
    ),
    [restHealthy, wsState.ready, wsState.status]
  );

  return (
    <>
      <Navbar bg="dark" variant="dark" expand="sm" className="mb-3">
        <Container>
          <Navbar.Brand>Bybit OI/Price Bot</Navbar.Brand>
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">
              Home
            </Nav.Link>
            <Nav.Link as={Link} to="/bot">
              Bot
            </Nav.Link>
            <Nav.Link as={Link} to="/doctor">
              Doctor
            </Nav.Link>
          </Nav>
          <span>{connectionBadge}</span>
        </Container>
      </Navbar>
      <Container className="pb-4">
        <Alert variant="secondary" className="py-2">
          Backend: {API_BASE}
        </Alert>
        <Routes>
          <Route
            path="/"
            element={
              <HomePage
                restHealthy={restHealthy}
                wsState={wsState}
              />
            }
          />
          <Route
            path="/bot"
            element={
              <BotPage
                botState={botState}
                universeState={universeState}
                symbolMap={symbolMap}
                logs={logs}
                syncRest={syncRest}
                symbolUpdatesPerSecond={symbolUpdatesPerSecond}
                wsConnected={wsState.ready}
              />
            }
          />
          <Route path="/doctor" element={<DoctorPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
    </>
  );
}

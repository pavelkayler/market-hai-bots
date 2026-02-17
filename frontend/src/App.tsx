import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Container, Nav, Navbar } from 'react-bootstrap';
import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { API_BASE, ApiRequestError, WS_URL, getBotState, getHealth, getUniverse, pauseBot, resumeBot, stopBot } from './api';
import type { BotState, QueueUpdatePayload, SymbolUpdatePayload, SymbolsUpdatePayload, UniverseState, WsEnvelope } from './types';
import { BotPage } from './pages/BotPage';
import { HomePage } from './pages/HomePage';

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
  const [restHealthy, setRestHealthy] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
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
    uptimeMs: 0
  });
  const [universeState, setUniverseState] = useState<UniverseState>({ ok: false, ready: false });
  const [symbolMap, setSymbolMap] = useState<Record<string, SymbolUpdatePayload>>({});
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [symbolUpdatesPerSecond, setSymbolUpdatesPerSecond] = useState(0);
  const [homeActionError, setHomeActionError] = useState('');
  const reconnectTimer = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const symbolUpdatesInWindowRef = useRef(0);

  const appendLog = useCallback((text: string, ts?: number) => {
    setLogs((prev) => pushLog(prev, { text, ts: ts ?? Date.now() }));
  }, []);

  const syncRest = useCallback(async () => {
    try {
      const [health, nextUniverse, nextBotState] = await Promise.all([getHealth(), getUniverse(), getBotState()]);
      setRestHealthy(health.ok);
      setUniverseState(nextUniverse);
      setBotState(nextBotState);
    } catch {
      setRestHealthy(false);
    }
  }, []);

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

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        appendLog('WS connected');
        void syncRest();
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }

        setWsConnected(false);
        appendLog('WS disconnected');
        scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as WsEnvelope;

        if (message.type === 'state') {
          const payload = message.payload as Partial<BotState>;
          const { paused: _paused, hasSnapshot: _hasSnapshot, lastConfig: _lastConfig, ...allowedPayload } = payload;
          setBotState((prev) => ({ ...prev, ...allowedPayload }));
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
  }, [appendLog, syncRest]);

  const connectionBadge = useMemo(
    () => (
      <>
        <Badge bg={restHealthy ? 'success' : 'danger'} className="me-2">
          REST {restHealthy ? 'up' : 'down'}
        </Badge>
        <Badge bg={wsConnected ? 'success' : 'danger'}>WS {wsConnected ? 'connected' : 'disconnected'}</Badge>
      </>
    ),
    [restHealthy, wsConnected]
  );

  const handleHomePause = async () => {
    setHomeActionError('');
    try {
      await pauseBot();
      await syncRest();
    } catch (err) {
      setHomeActionError((err as Error).message);
    }
  };

  const handleHomeResume = async () => {
    setHomeActionError('');
    try {
      await resumeBot();
      await syncRest();
    } catch (err) {
      const apiError = err as ApiRequestError;
      if (apiError.code === 'NO_SNAPSHOT') {
        setHomeActionError('Snapshot not found. Start a new session or wait for a snapshot to be saved.');
        return;
      }
      setHomeActionError(apiError.message);
    }
  };

  const handleHomeStop = async () => {
    setHomeActionError('');
    try {
      await stopBot();
      await syncRest();
    } catch (err) {
      setHomeActionError((err as Error).message);
    }
  };

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
          </Nav>
          <span>{connectionBadge}</span>
        </Container>
      </Navbar>
      <Container className="pb-4">
        <Alert variant="secondary" className="py-2">
          Backend: {API_BASE}
        </Alert>
        {homeActionError ? <Alert variant="danger">{homeActionError}</Alert> : null}
        <Routes>
          <Route
            path="/"
            element={
              <HomePage
                restHealthy={restHealthy}
                wsConnected={wsConnected}
                botState={botState}
                onPause={() => void handleHomePause()}
                onResume={() => void handleHomeResume()}
                onStop={() => void handleHomeStop()}
              />
            }
          />
          <Route
            path="/bot"
            element={
              <BotPage
                botState={botState}
                setBotState={setBotState}
                universeState={universeState}
                setUniverseState={setUniverseState}
                symbolMap={symbolMap}
                setSymbolMap={setSymbolMap}
                logs={logs}
                syncRest={syncRest}
                symbolUpdatesPerSecond={symbolUpdatesPerSecond}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Badge, Container, Nav, Navbar } from 'react-bootstrap';
import { Link, Navigate, Route, Routes } from 'react-router-dom';

import { WS_URL, getBotState, getHealth, getStatus } from './api';
import { BotPage } from './pages/BotPage';
import { HomePage } from './pages/HomePage';
import type { BotState, WsConnectionState } from './types';

export function App() {
  const [restHealthy, setRestHealthy] = useState(false);
  const [botState, setBotState] = useState<BotState | null>(null);
  const [bybitWs, setBybitWs] = useState<{ connected: boolean; lastMessageAt: number | null; lastTickerAt: number | null; subscribedCount: number; desiredCount: number } | null>(null);
  const [wsState, setWsState] = useState<WsConnectionState>({ ready: false, status: 'DISCONNECTED', lastError: null, connectedAt: null, lastMessageAt: null });
  const wsRef = useRef<WebSocket | null>(null);

  const sync = async () => {
    try {
      const [health, state, status] = await Promise.all([getHealth(), getBotState(), getStatus()]);
      setRestHealthy(health.ok);
      setBotState(state);
      setBybitWs(status.bybitWs);
    } catch {
      setRestHealthy(false);
    }
  };

  useEffect(() => {
    void sync();
    const interval = setInterval(() => void sync(), 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setWsState((prev) => ({ ...prev, status: 'CONNECTING', ready: false }));
    ws.onopen = () => setWsState({ ready: true, status: 'CONNECTED', lastError: null, connectedAt: Date.now(), lastMessageAt: Date.now() });
    ws.onmessage = (event) => {
      setWsState((prev) => ({ ...prev, lastMessageAt: Date.now() }));
      const packet = JSON.parse(event.data) as { type?: string; payload?: unknown };
      if (packet.type === 'state') {
        setBotState(packet.payload as BotState);
      }
    };
    ws.onerror = () => setWsState((prev) => ({ ...prev, ready: false, status: 'ERROR', lastError: 'WebSocket error' }));
    ws.onclose = () => setWsState((prev) => ({ ...prev, ready: false, status: 'DISCONNECTED' }));
    return () => ws.close();
  }, []);

  return (
    <Container fluid className="p-3 d-grid gap-3">
      <Navbar bg="dark" variant="dark" expand="md">
        <Container fluid>
          <Navbar.Brand as={Link} to="/">Market HAI Bots</Navbar.Brand>
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">Home</Nav.Link>
            <Nav.Link as={Link} to="/bot">Bot</Nav.Link>
          </Nav>
          <Badge bg={restHealthy ? 'success' : 'danger'}>{restHealthy ? 'REST OK' : 'REST DOWN'}</Badge>
        </Container>
      </Navbar>

      <Routes>
        <Route path="/" element={<HomePage wsState={wsState} bybitWs={bybitWs} botState={botState} />} />
        <Route path="/bot" element={<BotPage onRefresh={sync} botState={botState} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Container>
  );
}

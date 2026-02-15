import { useEffect, useMemo, useState } from 'react';
import { Badge, Card } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

const fmtAgeSec = (sec) => {
  const n = Number(sec);
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}m ${s}s`;
};

export default function StatusPage() {
  const [healthWs, setHealthWs] = useState(() => ({
    ws: { connected: false, lastSeenAt: null, rttMs: null },
    bybitWs: { wsConnected: false, subscribedCount: 0, lastTickAgeSec: null, snapshotAgeSec: null, activeIntervals: [] },
  }));

  const onWsMessage = useMemo(() => (_ev, msg) => {
    if (!msg) return;
    const type = msg.type === 'event' ? msg.topic : msg.type;
    if (type === 'status.health') {
      setHealthWs((prev) => ({ ...prev, ...(msg.payload || {}) }));
      return;
    }
    if (type === 'status.pong') {
      const tsEcho = Number(msg.payload?.tsEcho || Date.now());
      setHealthWs((prev) => ({ ...prev, ws: { ...(prev.ws || {}), connected: true, lastSeenAt: Date.now(), rttMs: Math.max(0, Date.now() - tsEcho) } }));
    }
  }, []);

  const { status: wsStatus, wsUrl, sendJson } = useWsClient({ onMessage: onWsMessage });

  useEffect(() => {
    if (wsStatus !== 'connected') return;
    sendJson({ type: 'status.watch', payload: { active: true } });
    const pingTimer = setInterval(() => sendJson({ type: 'status.ping', payload: { ts: Date.now() } }), 5000);
    return () => clearInterval(pingTimer);
  }, [wsStatus, sendJson]);

  const wsBadgeVariant = (s) => (s === 'connected' || s === 'ok' ? 'success' : s === 'waiting' || s === 'connecting' || s === 'reconnecting' ? 'warning' : 'secondary');
  const bybitState = healthWs?.bybitWs?.wsConnected ? 'ok' : 'waiting';

  return (
    <div className='d-grid gap-3'>
      <h3 className='m-0'>Status</h3>
      <Card>
        <Card.Body>
          <div className='fw-semibold mb-3'>WebSocket Health</div>
          <div className='d-flex align-items-center justify-content-between'>
            <div>
              <div className='fw-semibold'>Frontend ↔ Server</div>
              <div className='text-muted small'>{wsUrl} · RTT: {Number.isFinite(healthWs?.ws?.rttMs) ? `${healthWs.ws.rttMs} ms` : '—'}</div>
            </div>
            <Badge bg={wsBadgeVariant(wsStatus)}>{wsStatus}</Badge>
          </div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body className='d-grid gap-2'>
          <div className='fw-semibold mb-1'>Bybit</div>
          <div className='d-flex align-items-center justify-content-between'>
            <div className='text-muted small'>wsConnected: {String(Boolean(healthWs?.bybitWs?.wsConnected))} · subscribedCount: {Number(healthWs?.bybitWs?.subscribedCount || 0)} · lastTick age: {fmtAgeSec(healthWs?.bybitWs?.lastTickAgeSec)} · snapshot age: {fmtAgeSec(healthWs?.bybitWs?.snapshotAgeSec)} · activeIntervals: {(healthWs?.bybitWs?.activeIntervals || []).join(', ') || '—'}</div>
            <Badge bg={wsBadgeVariant(bybitState)}>{bybitState}</Badge>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}

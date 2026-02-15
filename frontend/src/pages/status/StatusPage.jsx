import { useEffect, useState } from 'react';
import { Badge, Card } from 'react-bootstrap';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

function fmtAge(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 60) return `${n}s`;
  return `${Math.floor(n / 60)}m ${n % 60}s`;
}

export default function StatusPage() {
  const [status, setStatus] = useState({ bybit: { wsConnected: false, subscribedCount: 0, activeIntervals: [] } });

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const next = await fetch(`${API_BASE}/api/status/watch`).then((r) => r.json());
        if (mounted) setStatus(next || {});
      } catch {
        if (mounted) setStatus({ bybit: { wsConnected: false, subscribedCount: 0, activeIntervals: [] } });
      }
    };
    load();
    const timer = setInterval(load, 1500);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  const bybit = status?.bybit || {};

  return (
    <div className='d-grid gap-3'>
      <h3 className='m-0'>Status</h3>
      <Card>
        <Card.Body className='d-grid gap-2'>
          <div className='d-flex align-items-center justify-content-between'>
            <div>
              <div className='fw-semibold'>Bybit</div>
              <div className='text-muted small'>
                subscribedCount: {Number(bybit.subscribedCount || 0)} · lastTick age: {fmtAge(bybit.lastTickAgeSec)} · snapshot age: {fmtAge(bybit.snapshotAgeSec)} · activeIntervals: {(bybit.activeIntervals || []).join(', ') || '—'}
              </div>
            </div>
            <Badge bg={bybit.wsConnected ? 'success' : 'warning'}>{bybit.wsConnected ? 'ok' : 'waiting'}</Badge>
          </div>
        </Card.Body>
      </Card>
    </div>
  );
}

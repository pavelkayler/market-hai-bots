import { useMemo, useState } from 'react';
import { Badge } from 'react-bootstrap';
import { useWsClient } from '../api/ws.js';

function fmtPnl(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

export default function BotsOverviewBar() {
  const [overview, setOverview] = useState({ paperBalance: 10000, bots: [] });

  const onMessage = useMemo(() => (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    const type = msg?.type === 'event' ? msg.topic : msg.type;
    const payload = msg?.payload;
    if (type === 'snapshot' && payload?.botsOverview) setOverview(payload.botsOverview);
    if (type === 'bots.overview' && payload) setOverview(payload);
  }, []);

  const { status } = useWsClient({ onMessage });

  return (
    <div style={{ background: '#1f2937', color: '#e5e7eb', padding: '6px 12px', fontSize: 13 }} className="d-flex flex-wrap gap-3 align-items-center">
      <span><strong>Paper balance:</strong> ${fmtPnl(overview?.paperBalance)}</span>
      <Badge bg={status === 'connected' ? 'success' : 'secondary'}>WS {status}</Badge>
      {(overview?.bots || []).map((bot) => (
        <span key={bot.name}>
          <strong>{bot.name}</strong>: <Badge bg={bot.status === 'RUNNING' ? 'success' : 'secondary'}>{bot.status || 'STOPPED'}</Badge> ({fmtPnl(bot.pnl)})
        </span>
      ))}
    </div>
  );
}

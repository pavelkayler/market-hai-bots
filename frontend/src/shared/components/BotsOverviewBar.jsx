import { useEffect, useMemo, useState } from 'react';
import { Badge } from 'react-bootstrap';
import { useWsClient } from '../api/ws.js';

function fmtPnl(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function fmtUptime(startedAt) {
  const ms = Date.now() - Number(startedAt || 0);
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function BotsOverviewBar() {
  const [overview, setOverview] = useState({ paperBalance: 10000, bots: [] });

  const onMessage = useMemo(() => (_event, msg) => {
    if (!msg) return;
    const type = msg?.type === 'event' ? msg.topic : msg.type;
    const payload = msg?.payload;
    if (type === 'bots.overview' && payload) setOverview(payload);
  }, []);

  const { status, subscribeTopics, unsubscribeTopics } = useWsClient({ onMessage });

  useEffect(() => {
    subscribeTopics?.(['bots.overview']);
    return () => unsubscribeTopics?.(['bots.overview']);
  }, [subscribeTopics, unsubscribeTopics]);

  return (
    <div style={{ background: '#1f2937', color: '#e5e7eb', padding: '6px 12px', fontSize: 13 }} className="d-flex flex-wrap gap-3 align-items-center">
      <span><strong>Paper balance:</strong> ${fmtPnl(overview?.paperBalance)}</span>
      <Badge bg={status === 'connected' ? 'success' : 'secondary'}>WS {status}</Badge>
      {(overview?.bots || []).map((bot) => (
        <span key={bot.name}>
          <strong>{bot.name}</strong>: <Badge bg={bot.status === 'RUNNING' ? 'success' : 'secondary'}>{bot.status || 'STOPPED'}</Badge> ({fmtPnl(bot.pnl)}){bot.status === 'RUNNING' ? ` uptime ${fmtUptime(bot.startedAt)}` : ''}
        </span>
      ))}
    </div>
  );
}

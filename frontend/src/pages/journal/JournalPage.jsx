import { useEffect, useMemo, useState } from 'react';
import { Card, Col, Form, Row, Table } from 'react-bootstrap';

function fmtNum(x, d = 2) { const n = Number(x); return Number.isFinite(n) ? n.toFixed(d) : '—'; }
function fmtTs(x) { const n = Number(x); return Number.isFinite(n) ? new Date(n).toLocaleString() : '—'; }

export default function JournalPage() {
  const [rows, setRows] = useState([]);
  const [botName, setBotName] = useState('');
  const [mode, setMode] = useState('');

  useEffect(() => {
    const qs = new URLSearchParams();
    if (botName) qs.set('botName', botName);
    if (mode) qs.set('mode', mode);
    fetch(`/api/journal?${qs.toString()}`).then((r) => r.json()).then((d) => setRows(Array.isArray(d?.rows) ? d.rows : [])).catch(() => setRows([]));
  }, [botName, mode]);

  const botOptions = useMemo(() => ['LeadLag', 'Pullback', 'RangeMetrics', 'Impulse'], []);

  return (
    <Card>
      <Card.Body>
        <Row className="g-2 mb-3">
          <Col md={3}><Form.Select value={botName} onChange={(e) => setBotName(e.target.value)}><option value="">All bots</option>{botOptions.map((b) => <option key={b} value={b}>{b}</option>)}</Form.Select></Col>
          <Col md={3}><Form.Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="">All modes</option><option value="paper">paper</option><option value="demo">demo</option></Form.Select></Col>
        </Row>
        <Table size="sm" hover responsive>
          <thead><tr><th>Time</th><th>Bot</th><th>Symbol</th><th>Side</th><th>Mode</th><th>PnL</th><th>ROI%</th><th>Reason close</th></tr></thead>
          <tbody>{rows.length ? rows.map((r) => <tr key={r.id}><td>{fmtTs(r.closedAt)}</td><td>{r.botName}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.mode}</td><td>{fmtNum(r.pnlUsdt, 4)}</td><td>{fmtNum(r.roiPct, 2)}</td><td>{r.reasonClose || '—'}</td></tr>) : <tr><td colSpan={8} className="text-muted">No records</td></tr>}</tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}

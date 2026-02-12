import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Tab, Table, Tabs } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { const n = Number(ts); return Number.isFinite(n) ? new Date(n).toLocaleTimeString() : '—'; }
function fmtUptime(startedAt) {
  const sec = Math.max(0, Math.floor((Date.now() - Number(startedAt || 0)) / 1000));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function LeadLagPage() {
  const [state, setState] = useState({ status: 'STOPPED' });
  const [rows, setRows] = useState([]);
  const [searchActive, setSearchActive] = useState(false);
  const [leaderSymbol, setLeaderSymbol] = useState('BTCUSDT');
  const [followerSymbol, setFollowerSymbol] = useState('ETHUSDT');
  const [leaderMovePct, setLeaderMovePct] = useState(1);
  const [followerTpPct, setFollowerTpPct] = useState(1);
  const [followerSlPct, setFollowerSlPct] = useState(1);
  const [allowShort, setAllowShort] = useState(true);

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type === 'event' ? msg.topic : msg.type;
    if (type === 'snapshot' && msg.payload?.leadlagState) setState(msg.payload.leadlagState);
    if (type === 'leadlag.state') setState(msg.payload || {});
    if (type === 'leadlag.top') setRows(Array.isArray(msg.payload?.rows) ? msg.payload.rows : (Array.isArray(msg.payload) ? msg.payload : []));
    if (type === 'leadlag.search.ack') setSearchActive(Boolean(msg.payload?.active));
  }, []);

  const { status, sendJson } = useWsClient({ onOpen: () => sendJson({ type: 'getLeadLagState' }), onMessage });

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body className='d-grid gap-2'>
      <div className='d-flex justify-content-between'><strong>LeadLag</strong><Badge bg={status === 'connected' ? 'success' : 'secondary'}>{status}</Badge></div>
      <div className='d-flex justify-content-between'><span>Status</span><Badge bg={state?.status === 'RUNNING' ? 'success' : 'secondary'}>{state?.status || '—'}</Badge></div>
      {state?.status === 'RUNNING' && <div className='text-muted'>Uptime {fmtUptime(state?.startedAt)}</div>}
      <Tabs defaultActiveKey='trading'>
        <Tab eventKey='trading' title='Trading'>
          <div className='d-grid gap-2 mt-2'>
            <Form.Control value={leaderSymbol} onChange={(e) => setLeaderSymbol(e.target.value.toUpperCase())} placeholder='Leader symbol' />
            <Form.Control value={followerSymbol} onChange={(e) => setFollowerSymbol(e.target.value.toUpperCase())} placeholder='Follower symbol' />
            <Form.Control type='number' value={leaderMovePct} onChange={(e) => setLeaderMovePct(Number(e.target.value))} />
            <Form.Control type='number' value={followerTpPct} onChange={(e) => setFollowerTpPct(Number(e.target.value))} />
            <Form.Control type='number' value={followerSlPct} onChange={(e) => setFollowerSlPct(Number(e.target.value))} />
            <Form.Check checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} label='allowShort' />
            <div className='d-flex gap-2'>
              <Button onClick={() => sendJson({ type: 'startLeadLag', settings: { leaderSymbol, followerSymbol, leaderMovePct, followerTpPct, followerSlPct, allowShort } })}>Start</Button>
              <Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLag' })}>Stop</Button>
            </div>
          </div>
        </Tab>
        <Tab eventKey='search' title='Search'>
          <div className='d-flex gap-2 mt-2'>
            <Button onClick={() => sendJson({ type: 'startLeadLagSearch' })}>Start search</Button>
            <Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLagSearch' })}>Stop search</Button>
            <Badge bg={searchActive ? 'success' : 'secondary'}>{searchActive ? 'ACTIVE' : 'STOPPED'}</Badge>
          </div>
        </Tab>
      </Tabs>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      <div className='fw-semibold mb-2'>Results</div>
      <Table size='sm'><thead><tr><th>Leader</th><th>Follower</th><th>Corr</th><th>Lag(ms)</th><th>Score</th><th>Time</th></tr></thead><tbody>
        {rows.slice(0, 100).map((r, i) => <tr key={i}><td>{r.leader}</td><td>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs,0)}</td><td>{fmt(r.score)}</td><td>{fmtTs(r.ts)}</td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
  </Row>
}

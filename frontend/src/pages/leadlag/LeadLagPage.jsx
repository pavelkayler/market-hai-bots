import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Tab, Table, Tabs } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
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
  const [sort, setSort] = useState({ key: 'corr', dir: 'desc' });

  function calcDivergencePct(row) {
    const corr = Math.abs(Number(row?.corr));
    if (!Number.isFinite(corr)) return null;
    return Math.abs(1 - Math.min(1, corr)) * 100;
  }

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type === 'event' ? msg.topic : msg.type;
    if (type === 'snapshot' && msg.payload?.leadlagState) setState(msg.payload.leadlagState);
    if (type === 'leadlag.state') setState(msg.payload || {});
    if (type === 'leadlag.top' && searchActive) {
      setRows(Array.isArray(msg.payload?.rows) ? msg.payload.rows : (Array.isArray(msg.payload) ? msg.payload : []));
    }
    if (type === 'leadlag.search.ack') setSearchActive(Boolean(msg.payload?.active));
  }, [searchActive]);

  const { status, sendJson } = useWsClient({ onOpen: () => sendJson({ type: 'getLeadLagState' }), onMessage });

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const factor = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === 'leader' || sort.key === 'follower') {
        return factor * String(a?.[sort.key] || '').localeCompare(String(b?.[sort.key] || ''));
      }
      const av = Number(a?.[sort.key]);
      const bv = Number(b?.[sort.key]);
      return factor * ((Number.isFinite(av) ? av : -Infinity) - (Number.isFinite(bv) ? bv : -Infinity));
    });
    return list;
  }, [rows, sort]);

  const tradingRows = useMemo(() => {
    const list = Array.isArray(state?.lastLeadLagTop) ? state.lastLeadLagTop : [];
    return list.slice(0, 10).map((r) => ({ ...r, divergencePct: calcDivergencePct(r) }));
  }, [state]);

  const tradeStats = useMemo(() => {
    const stats = state?.stats || {};
    return {
      trades: Number(stats.trades || 0),
      wins: Number(stats.wins || 0),
      losses: Number(stats.losses || 0),
      winRate: Number(stats.winRate || 0),
      pnlUSDT: Number(stats.pnlUSDT || 0),
    };
  }, [state]);

  function toggleSort(key) {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  }

  function sortMark(key) {
    if (sort.key !== key) return '';
    return sort.dir === 'desc' ? ' ↓' : ' ↑';
  }

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body className='d-grid gap-2'>
      <div className='d-flex justify-content-between'><strong>LeadLag</strong><Badge bg={status === 'connected' ? 'success' : 'secondary'}>{status}</Badge></div>
      <div className='d-flex justify-content-between'><span>Status</span><Badge bg={state?.status === 'RUNNING' ? 'success' : 'secondary'}>{state?.status || '—'}</Badge></div>
      {state?.status === 'RUNNING' && <div className='text-muted'>Uptime {fmtUptime(state?.startedAt)}</div>}
      <Tabs defaultActiveKey='trading'>
        <Tab eventKey='trading' title='Trading'>
          <div className='d-grid gap-2 mt-2'>
            <Form.Group>
              <Form.Label>Leader symbol</Form.Label>
              <Form.Control value={leaderSymbol} onChange={(e) => setLeaderSymbol(e.target.value.toUpperCase())} />
            </Form.Group>
            <Form.Group>
              <Form.Label>Follower symbol</Form.Label>
              <Form.Control value={followerSymbol} onChange={(e) => setFollowerSymbol(e.target.value.toUpperCase())} />
            </Form.Group>
            <Form.Group>
              <Form.Label>Leader move trigger (%)</Form.Label>
              <Form.Control type='number' min={0} value={leaderMovePct} onChange={(e) => setLeaderMovePct(Number(e.target.value))} />
            </Form.Group>
            <Form.Group>
              <Form.Label>Follower take-profit (%)</Form.Label>
              <Form.Control type='number' min={0} value={followerTpPct} onChange={(e) => setFollowerTpPct(Number(e.target.value))} />
            </Form.Group>
            <Form.Group>
              <Form.Label>Follower stop-loss (%)</Form.Label>
              <Form.Control type='number' min={0} value={followerSlPct} onChange={(e) => setFollowerSlPct(Number(e.target.value))} />
            </Form.Group>
            <Form.Check checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} label='allowShort' />
            <div className='d-flex gap-2'>
              <Button onClick={() => sendJson({ type: 'startLeadLag', settings: { leaderSymbol, followerSymbol, leaderMovePct, followerTpPct, followerSlPct, allowShort } })}>Start</Button>
              <Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLag' })}>Stop</Button>
            </div>
          </div>
        </Tab>
        <Tab eventKey='search' title='Search'>
          <div className='d-flex gap-2 mt-2'>
            <Button onClick={() => { setSearchActive(true); sendJson({ type: 'startLeadLagSearch' }); }}>Start search</Button>
            <Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLagSearch' })}>Stop search</Button>
            <Badge bg={searchActive ? 'success' : 'secondary'}>{searchActive ? 'ACTIVE' : 'STOPPED'}</Badge>
          </div>
        </Tab>
      </Tabs>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      <div className='fw-semibold mb-2'>Results</div>
      <div className='small text-muted mb-2'>Trades: {tradeStats.trades} · Wins: {tradeStats.wins} · Losses: {tradeStats.losses} · Win rate: {fmt(tradeStats.winRate, 1)}% · PnL: {fmt(tradeStats.pnlUSDT, 3)} USDT</div>
      <Table size='sm'><thead><tr><th>Leader</th><th>Follower</th><th>Corr</th><th>Lag(ms)</th><th>Divergence (%)</th></tr></thead><tbody>
        {tradingRows.map((r, i) => <tr key={`${r.leader}-${r.follower}-${i}`}><td>{r.leader}</td><td>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs, 0)}</td><td>{fmt(r.divergencePct, 2)}</td></tr>)}
      </tbody></Table>

      <div className='fw-semibold mt-4 mb-2'>Search (top 10, sortable)</div>
      <Table size='sm' style={{ tableLayout: 'fixed' }}><thead><tr><th style={{ width: '28%' }} role='button' onClick={() => toggleSort('leader')}>Leader{sortMark('leader')}</th><th style={{ width: '28%' }} role='button' onClick={() => toggleSort('follower')}>Follower{sortMark('follower')}</th><th style={{ width: '22%' }} role='button' onClick={() => toggleSort('corr')}>Corr{sortMark('corr')}</th><th style={{ width: '22%' }} role='button' onClick={() => toggleSort('lagMs')}>Lag(ms){sortMark('lagMs')}</th></tr></thead><tbody>
        {sortedRows.slice(0, 10).map((r, i) => <tr key={`${r.leader}-${r.follower}-${i}`}><td className='text-truncate'>{r.leader}</td><td className='text-truncate'>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs, 0)}</td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
  </Row>
}

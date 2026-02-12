import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Tab, Table, Tabs } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—'; }
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

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type === 'event' ? msg.topic : msg.type;
    const payload = msg.payload;

    if (type === 'snapshot' && payload?.leadlagState) {
      setState(payload.leadlagState);
      return;
    }
    if (type === 'leadlag.state') {
      setState((prev) => ({
        ...(prev || {}),
        ...(payload || {}),
        logs: Array.isArray(payload?.logs) ? payload.logs : (prev?.logs || []),
        trades: Array.isArray(payload?.trades) ? payload.trades : (prev?.trades || []),
      }));
      return;
    }
    if (type === 'leadlag.log') {
      setState((prev) => ({ ...(prev || {}), logs: [payload, ...(prev?.logs || [])].slice(0, 200) }));
      return;
    }
    if (type === 'leadlag.trade') {
      setState((prev) => ({ ...(prev || {}), trades: [payload, ...(prev?.trades || [])].slice(0, 200) }));
      return;
    }
    if (type === 'leadlag.position') {
      setState((prev) => ({ ...(prev || {}), position: payload || null }));
      return;
    }
    if (type === 'leadlag.start.ack' && payload?.state) {
      setState(payload.state);
      return;
    }
    if (type === 'leadlag.top' && searchActive) {
      setRows(Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload) ? payload : []));
      return;
    }
    if (type === 'leadlag.search.ack') setSearchActive(Boolean(payload?.active));
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

  const noEntryReasons = useMemo(() => {
    if (Array.isArray(state?.lastNoEntryReasons) && state.lastNoEntryReasons.length) return state.lastNoEntryReasons.slice(0, 3);
    return (state?.logs || [])
      .filter((x) => /WAIT_LEADER_MOVE|SHORT_DISABLED|NO_FOLLOWER_PRICE|NO_LEADER_PRICE|NO ENTRY/i.test(String(x?.msg || '')))
      .slice(0, 3)
      .map((x) => ({ key: 'LOG', detail: x.msg, ts: x.ts }));
  }, [state]);

  const recentTrades = useMemo(() => (Array.isArray(state?.trades) ? state.trades.slice(0, 20) : []), [state]);

  function toggleSort(key) {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }));
  }

  function sortMark(key) {
    if (sort.key !== key) return '';
    return sort.dir === 'desc' ? ' ↓' : ' ↑';
  }

  const manual = state?.manual || {};
  const currentPosition = state?.position;

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
      <div className='fw-semibold mb-2'>Trading diagnostics</div>
      <div className='small text-muted mb-2'>Trades: {tradeStats.trades} · Wins: {tradeStats.wins} · Losses: {tradeStats.losses} · Win rate: {fmt(tradeStats.winRate, 1)}% · PnL: {fmt(tradeStats.pnlUSDT, 3)} USDT</div>
      <Table size='sm'><tbody>
        <tr><td>Leader/Follower</td><td>{manual.leaderSymbol || '—'} / {manual.followerSymbol || '—'}</td></tr>
        <tr><td>Leader/Follower price</td><td>{fmt(manual.leaderPrice, 4)} / {fmt(manual.followerPrice, 4)}</td></tr>
        <tr><td>Baseline</td><td>{fmt(manual.leaderBaseline, 4)}</td></tr>
        <tr><td>Leader move now</td><td>{fmt(manual.leaderMovePctNow, 4)}%</td></tr>
        <tr><td>Position</td><td>{currentPosition ? `${currentPosition.side} ${currentPosition.symbol} @ ${fmt(currentPosition.entryPrice, 4)} qty=${fmt(currentPosition.qty, 4)}` : 'No open position'}</td></tr>
      </tbody></Table>

      <div className='fw-semibold mt-3 mb-2'>No entry reasons (top-3)</div>
      <Table size='sm'><tbody>
        {noEntryReasons.length ? noEntryReasons.map((r, i) => <tr key={`${r.key}-${i}`}><td>{r.key}</td><td>{r.detail || `${fmt(r.value, 4)} vs ${fmt(r.threshold, 4)}`}</td></tr>) : <tr><td className='text-muted'>No blockers</td></tr>}
      </tbody></Table>

      <div className='fw-semibold mt-3 mb-2'>Trade events (last 20)</div>
      <div style={{ maxHeight: 250, overflow: 'auto' }}>
        <Table size='sm'><thead><tr><th>Time</th><th>Event</th><th>Symbol</th><th>Side</th><th>Entry/Exit</th><th>PnL</th></tr></thead><tbody>
          {recentTrades.length ? recentTrades.map((t, i) => <tr key={`${t.ts || i}-${i}`}><td>{fmtTs(t.ts)}</td><td>{t.event || '—'}</td><td>{t.symbol}</td><td>{t.side}</td><td>{fmt(t.entry || t.entryPrice || t.exitPrice, 4)}</td><td>{fmt(t.pnlUSDT, 4)}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No trade events</td></tr>}
        </tbody></Table>
      </div>

      <div className='fw-semibold mt-4 mb-2'>Search (top 10, sortable)</div>
      <Table size='sm' style={{ tableLayout: 'fixed' }}><thead><tr><th style={{ width: '28%' }} role='button' onClick={() => toggleSort('leader')}>Leader{sortMark('leader')}</th><th style={{ width: '28%' }} role='button' onClick={() => toggleSort('follower')}>Follower{sortMark('follower')}</th><th style={{ width: '22%' }} role='button' onClick={() => toggleSort('corr')}>Corr{sortMark('corr')}</th><th style={{ width: '22%' }} role='button' onClick={() => toggleSort('lagMs')}>Lag(ms){sortMark('lagMs')}</th></tr></thead><tbody>
        {sortedRows.slice(0, 10).map((r, i) => <tr key={`${r.leader}-${r.follower}-${i}`}><td className='text-truncate'>{r.leader}</td><td className='text-truncate'>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs, 0)}</td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

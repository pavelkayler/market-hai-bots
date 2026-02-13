import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Col, Form, ProgressBar, Row, Table } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';
import './LeadLagPage.css';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—'; }

const defaultSettings = { leaderSymbol: 'BTCUSDT', followerSymbol: 'ETHUSDT', leaderMovePct: 0.1, followerTpPct: 0.1, followerSlPct: 0.1, allowShort: true, lagMs: 250 };
const lagOptions = [250, 500, 750, 1000];

export default function LeadLagPage() {
  const [state, setState] = useState({ schemaVersion: 1, trading: { status: 'STOPPED' }, search: { status: 'IDLE', progress: { phase: 'IDLE', done: 0, total: 0 } } });
  const [formSettings, setFormSettings] = useState(defaultSettings);
  const [rows, setRows] = useState([]);
  const [serverNow, setServerNow] = useState(0);
  const [tradeState, setTradeState] = useState({ executionMode: 'paper', killSwitch: false, warnings: [], tradeStatus: { guardrails: {} } });
  const [guardrailsForm, setGuardrailsForm] = useState({ maxNotionalUsd: 100, maxLeverage: 10, maxActivePositions: 1 });
  const [exchangePositions, setExchangePositions] = useState([]);
  const [exchangeOrders, setExchangeOrders] = useState([]);
  const [tradeError, setTradeError] = useState('');
  const lastTopUpdateAtRef = useRef(0);

  const applySnapshot = useCallback((payload = null) => {
    if (!payload || typeof payload !== 'object') return;
    setState((prev) => ({ ...(prev || {}), ...(payload || {}) }));
    const nextRows = payload?.search?.results?.top || payload?.search?.topRows || [];
    if (Array.isArray(nextRows)) setRows(nextRows.slice(0, 50));
  }, []);

  const onMessage = useMemo(() => (_ev, msg) => {
    if (!msg) return;
    setServerNow(Date.now());
    const type = msg.type === 'event' ? msg.topic : msg.type;
    const payload = msg.payload;

    if (type === 'leadlag.state') { applySnapshot(payload); return; }
    if (type === 'leadlag.searchProgress') { setState((prev) => ({ ...(prev || {}), search: { ...(prev?.search || {}), progress: { ...(prev?.search?.progress || {}), ...(payload || {}) }, updatedAtMs: Date.now() } })); return; }
    if (type === 'leadlag.searchResults') {
      const topRows = Array.isArray(payload?.top) ? payload.top : [];
      setRows(topRows.slice(0, 50));
      setState((prev) => ({ ...(prev || {}), search: { ...(prev?.search || {}), results: { ...(prev?.search?.results || {}), ...(payload || {}) }, updatedAtMs: Date.now() } }));
      return;
    }
    if (type === 'leadlag.top') {
      const topRows = Array.isArray(payload?.topRows) ? payload.topRows : [];
      const now = Date.now();
      if (now - lastTopUpdateAtRef.current >= 250) { setRows(topRows.slice(0, 50)); lastTopUpdateAtRef.current = now; }
      return;
    }
    if (type === 'trade.state') {
      setTradeState(payload || {});
      const g = payload?.tradeStatus?.guardrails || {};
      setGuardrailsForm((prev) => ({
        maxNotionalUsd: Number.isFinite(Number(g.maxNotionalUsd)) ? Number(g.maxNotionalUsd) : prev.maxNotionalUsd,
        maxLeverage: Number.isFinite(Number(g.maxLeverage)) ? Number(g.maxLeverage) : prev.maxLeverage,
        maxActivePositions: Number.isFinite(Number(g.maxActivePositions)) ? Number(g.maxActivePositions) : prev.maxActivePositions,
      }));
      return;
    }
    if (type === 'trade.positions') { setExchangePositions(Array.isArray(payload?.positions) ? payload.positions.slice(0, 20) : []); return; }
    if (type === 'trade.orders') { setExchangeOrders(Array.isArray(payload?.orders) ? payload.orders.slice(0, 50) : []); return; }
    if ((type === 'leadlag.start.ack' || type === 'leadlag.reset.ack') && payload?.state?.settings) setFormSettings((prev) => ({ ...prev, ...payload.state.settings }));
  }, [applySnapshot]);

  const { status, request, subscribeTopics, unsubscribeTopics } = useWsClient({ onMessage });

  useEffect(() => {
    if (status !== 'connected') return;
    let active = true;
    subscribeTopics?.(['leadlag.*', 'trade.*']);
    request('leadlag.getState').then((snapshot) => { if (active) applySnapshot(snapshot); });
    request('trade.getState').then((snap) => { if (active && snap) setTradeState(snap); });
    request('trade.syncNow', {}).then(() => {});
    return () => { active = false; unsubscribeTopics?.(['leadlag.*', 'trade.*']); };
  }, [status, subscribeTopics, unsubscribeTopics, request, applySnapshot]);

  const canStart = status === 'connected' && String(formSettings.leaderSymbol || '').trim().length > 0 && String(formSettings.followerSymbol || '').trim().length > 0;
  const trading = state?.trading || {};
  const search = state?.search || {};
  const searchStatus = String(search?.status || search?.phase || 'IDLE').toUpperCase();
  const isSearchRunning = !['IDLE', 'FINISHED', 'ERROR'].includes(searchStatus);
  const mode = tradeState?.executionMode || trading?.execution?.mode || 'paper';
  const modeChangeBlocked = ['RUNNING', 'STARTING'].includes(String(trading?.status || 'STOPPED').toUpperCase());

  const progress = search?.progress || {};
  const progressDone = Number(progress.done || 0);
  const progressTotal = Math.max(1, Number(progress.total || 0));
  const progressPct = Number(progress.pct || ((progressDone / progressTotal) * 100));
  const searchMessage = String(progress.message || search.message || '—');
  const searchError = searchStatus === 'ERROR' && search?.error ? `${search.error.code || 'ERROR'}: ${search.error.message || 'Search failed'}` : '';

  const positions = Array.isArray(trading?.positions) ? trading.positions : [];
  const tradeEvents = Array.isArray(trading?.tradeEvents) ? trading.tradeEvents : [];
  const tradeHistory = Array.isArray(trading?.history) ? trading.history : [];
  const noEntryReasons = Array.isArray(trading?.noEntryReasons) ? trading.noEntryReasons : [];

  const pairLeader = trading?.pair?.leader || formSettings.leaderSymbol;
  const pairFollower = trading?.pair?.follower || formSettings.followerSymbol;
  const leaderPx = trading?.prices?.leader?.mark || trading?.prices?.leader?.last;
  const followerPx = trading?.prices?.follower?.mark || trading?.prices?.follower?.last;
  const leaderBaseline = trading?.baseline?.leader0;
  const leaderMoveNow = trading?.telemetry?.leaderMovePct;
  const lastSearchUpdateMs = Number(search?.results?.updatedAtMs || search?.updatedAtMs || 0);

  const applyTradeMode = async (nextMode) => {
    setTradeError('');
    const res = await request('trade.setMode', { mode: nextMode });
    if (!res?.ok) { setTradeError(res?.reason || 'Failed to set mode'); return; }
    setTradeState(res);
    const snapshot = await request('leadlag.getState');
    if (snapshot) applySnapshot(snapshot);
  };


  const handleEmergencyAction = async (method, confirmText) => {
    if (!window.confirm(confirmText)) return;
    setTradeError('');
    const res = await request(method, { symbol: pairFollower });
    if (!res?.ok) {
      setTradeError(res?.reason || 'Emergency action failed');
      return;
    }
    setTimeout(() => { request('trade.syncNow', { symbol: pairFollower }); }, 150);
  };

  return <div className='d-grid gap-3'>
    <Row className='g-3'>
      <Col lg={6}>
        <Card><Card.Body className='d-grid gap-3'>
          <div className='d-flex justify-content-between align-items-center'><div className='fw-semibold'>LeadLag trading</div><Badge bg={trading?.status === 'RUNNING' ? 'success' : 'secondary'}>{trading?.status || 'STOPPED'}</Badge></div>
          <Row className='g-2'>
            <Col md={4}><Form.Group><Form.Label>Leader</Form.Label><Form.Control value={formSettings.leaderSymbol} onChange={(e) => setFormSettings((p) => ({ ...p, leaderSymbol: String(e.target.value || '').toUpperCase() }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Follower</Form.Label><Form.Control value={formSettings.followerSymbol} onChange={(e) => setFormSettings((p) => ({ ...p, followerSymbol: String(e.target.value || '').toUpperCase() }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Trigger (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.leaderMovePct} onChange={(e) => setFormSettings((p) => ({ ...p, leaderMovePct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>TP (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.followerTpPct} onChange={(e) => setFormSettings((p) => ({ ...p, followerTpPct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>SL (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.followerSlPct} onChange={(e) => setFormSettings((p) => ({ ...p, followerSlPct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Lag (ms)</Form.Label><Form.Select value={formSettings.lagMs} onChange={(e) => setFormSettings((p) => ({ ...p, lagMs: Number(e.target.value) }))}>{lagOptions.map((x) => <option key={x} value={x}>{x}</option>)}</Form.Select></Form.Group></Col>
            <Col md={4} className='d-flex align-items-end'><Form.Check label='Allow short' checked={Boolean(formSettings.allowShort)} onChange={(e) => setFormSettings((p) => ({ ...p, allowShort: e.target.checked }))} /></Col>
            <Col md={12} className='d-flex gap-2'><Button disabled={!canStart} onClick={() => request('leadlag.trading.start', { ...formSettings, leader: formSettings.leaderSymbol, follower: formSettings.followerSymbol })}>Start trading</Button><Button variant='outline-secondary' onClick={() => request('leadlag.trading.stop', {})}>Stop</Button><Button variant='outline-danger' onClick={() => request('leadlag.trading.reset', {})}>Reset</Button></Col>
          </Row>
        </Card.Body></Card>
      </Col>

      <Col lg={6}>
        <Card><Card.Body className='d-grid gap-3'>
          <div className='d-flex justify-content-between align-items-center'><div className='fw-semibold'>Execution controls</div><Badge bg={mode === 'real' ? 'danger' : mode === 'demo' ? 'warning' : 'secondary'}>{mode.toUpperCase()}</Badge></div>
          <Row className='g-2'>
            <Col md={4}><Form.Group><Form.Label>Mode</Form.Label><Form.Select value={mode} disabled={modeChangeBlocked} onChange={(e) => applyTradeMode(e.target.value)}><option value='paper'>paper</option><option value='demo'>demo</option><option value='real'>real</option></Form.Select></Form.Group></Col>
            <Col md={4} className='d-flex align-items-end'><Form.Check label='Kill-switch' checked={Boolean(tradeState?.killSwitch)} onChange={(e) => request('trade.setKillSwitch', { enabled: e.target.checked }).then((r) => { if (!r?.ok) setTradeError('Failed to set kill-switch'); })} /></Col>
            <Col md={4} className='d-flex align-items-end'><Button size='sm' variant='outline-secondary' onClick={() => request('trade.syncNow', { symbol: pairFollower })}>Sync now</Button></Col>
            <Col md={4}><Form.Group><Form.Label>Max notional</Form.Label><Form.Control type='number' value={guardrailsForm.maxNotionalUsd} onChange={(e) => setGuardrailsForm((p) => ({ ...p, maxNotionalUsd: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Max leverage</Form.Label><Form.Control type='number' value={guardrailsForm.maxLeverage} onChange={(e) => setGuardrailsForm((p) => ({ ...p, maxLeverage: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Max positions</Form.Label><Form.Control type='number' value={guardrailsForm.maxActivePositions} onChange={(e) => setGuardrailsForm((p) => ({ ...p, maxActivePositions: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={12}><Button size='sm' onClick={() => request('trade.setGuardrails', guardrailsForm).then((r) => { if (!r?.ok) setTradeError('Failed to apply guardrails'); })}>Apply guardrails</Button></Col>
            {mode !== 'paper' ? <Col md={12} className='d-flex gap-2'><Button size='sm' variant='outline-warning' onClick={() => handleEmergencyAction('trade.cancelAll', `Cancel all orders for ${pairFollower}?`)}>Cancel all orders</Button><Button size='sm' variant='outline-danger' onClick={() => handleEmergencyAction('trade.panicClose', `Panic close ${pairFollower} position and cancel all orders?`)}>Panic close</Button></Col> : null}
          </Row>
          {tradeError ? <div className='small text-warning'>{tradeError}</div> : null}
          <div className='small text-muted'>{Array.isArray(tradeState?.warnings) && tradeState.warnings.length ? tradeState.warnings.slice(0, 3).map((w) => w?.message || w?.code).join(' · ') : 'No warnings'}</div>
        </Card.Body></Card>
      </Col>
    </Row>

    <Card><Card.Body className='d-grid gap-3'>
      <div className='fw-semibold'>Trading diagnostics</div>
      <div className='small'>Pair: {pairLeader} / {pairFollower}</div>
      <div className='small'>Leader px {fmt(leaderPx)} · Follower px {fmt(followerPx)} · Baseline {fmt(leaderBaseline)} · Leader move now {fmt(leaderMoveNow, 2)}%</div>
      <div className='small fw-semibold'>Stats</div>
      <div className='small text-muted'>Trades {Number(trading?.stats?.line1?.trades || 0)} / Wins {Number(trading?.stats?.line1?.wins || 0)} / Losses {Number(trading?.stats?.line1?.losses || 0)} / Winrate {fmt(trading?.stats?.line1?.winratePct, 2)}% / PnL {fmt(trading?.stats?.line1?.pnl, 4)}</div>
      <div className='small text-muted'>Fees {fmt(trading?.stats?.line2?.fees, 4)} / Funding {fmt(trading?.stats?.line2?.funding, 4)} / Slippage {fmt(trading?.stats?.line2?.slippage, 4)} / FeeRate {fmt(trading?.stats?.line2?.feeRateBps, 2)} bps</div>
      <div style={{ maxHeight: 160, overflow: 'auto' }}><Table size='sm'><thead><tr><th>Side</th><th>Entry</th><th>Qty</th><th>TP/SL</th><th>Unrealized</th><th>Age</th></tr></thead><tbody>{positions.length ? positions.map((p) => { const sideSign = p?.side === 'SHORT' ? -1 : 1; const unreal = Number.isFinite(Number(followerPx)) ? ((Number(followerPx) - Number(p.entryPrice || 0)) * Number(p.qty || 0) * sideSign) : null; const ageSec = Number.isFinite(Number(p?.openedAt)) && Number(serverNow) > 0 ? Math.max(0, (Number(serverNow) - Number(p.openedAt)) / 1000) : null; return <tr key={p.id || `${p.symbol}_${p.openedAt}`}><td>{p.side}</td><td>{fmt(p.entryPrice, 4)}</td><td>{fmt(p.qty, 4)}</td><td>{fmt(p.tpPrice, 4)} / {fmt(p.slPrice, 4)}</td><td>{fmt(unreal, 4)}</td><td>{Number.isFinite(ageSec) ? `${Math.round(ageSec)}s` : '—'}</td></tr>; }) : <tr><td colSpan={6} className='text-muted'>No open positions</td></tr>}</tbody></Table></div>
      <div className='fw-semibold'>No entry reasons</div><div className='small text-muted'>{noEntryReasons.length ? noEntryReasons.join(' · ') : '—'}</div>
      <div style={{ maxHeight: 180, overflow: 'auto' }}><Table size='sm'><thead><tr><th>Time</th><th>Event</th><th>Symbol</th><th>Side</th><th>Price</th><th>PnL</th></tr></thead><tbody>{tradeEvents.length ? tradeEvents.map((e, idx) => <tr key={`${e.ts}-${idx}`}><td>{fmtTs(e.ts)}</td><td>{e.event}</td><td>{e.symbol}</td><td>{e.side || '—'}</td><td>{fmt(e.exitPrice ?? e.entryPrice, 4)}</td><td>{fmt(e.pnlUSDT, 4)}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No events in current run</td></tr>}</tbody></Table></div>
      <div style={{ maxHeight: 180, overflow: 'auto' }}><Table size='sm'><thead><tr><th>Closed</th><th>Side</th><th>Entry</th><th>Exit</th><th>Qty</th><th>PnL</th><th>Fees</th><th>Funding</th><th>Slip</th><th>Reason</th><th>Dur(s)</th></tr></thead><tbody>{tradeHistory.length ? tradeHistory.map((t, idx) => <tr key={`${t.closedAt}-${idx}`}><td>{fmtTs(t.closedAt)}</td><td>{t.side}</td><td>{fmt(t.entryPrice, 4)}</td><td>{fmt(t.exitPrice, 4)}</td><td>{fmt(t.qty, 4)}</td><td>{fmt(t.pnl, 4)}</td><td>{fmt(t.fees, 4)}</td><td>{fmt(t.funding, 4)}</td><td>{fmt(t.slippage, 4)}</td><td>{t.reason || '—'}</td><td>{fmt(t.durationSec, 1)}</td></tr>) : <tr><td colSpan={11} className='text-muted'>No closed trades in current run</td></tr>}</tbody></Table></div>
    </Card.Body></Card>

    {mode !== 'paper' && <Row className='g-3'>
      <Col lg={6}><Card><Card.Body><div className='fw-semibold mb-2'>Exchange Positions</div><div style={{ maxHeight: 220, overflow: 'auto' }}><Table size='sm'><colgroup><col style={{ width: '18%' }} /><col style={{ width: '12%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /><col style={{ width: '16%' }} /></colgroup><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Avg</th><th>UPnL</th><th>Mode</th></tr></thead><tbody>{exchangePositions.length ? exchangePositions.map((p, i) => <tr key={`${p.symbol}_${p.positionIdx}_${i}`}><td>{p.symbol}</td><td>{p.side}</td><td>{fmt(p.size, 4)}</td><td>{fmt(p.avgPrice, 4)}</td><td>{fmt(p.unrealisedPnl, 4)}</td><td>{p.marginMode || '—'}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No exchange positions</td></tr>}</tbody></Table></div></Card.Body></Card></Col>
      <Col lg={6}><Card><Card.Body><div className='fw-semibold mb-2'>Exchange Orders</div><div style={{ maxHeight: 220, overflow: 'auto' }}><Table size='sm'><colgroup><col style={{ width: '18%' }} /><col style={{ width: '12%' }} /><col style={{ width: '18%' }} /><col style={{ width: '18%' }} /><col style={{ width: '14%' }} /><col style={{ width: '20%' }} /></colgroup><thead><tr><th>Symbol</th><th>Side</th><th>Price</th><th>Qty</th><th>Status</th><th>Created</th></tr></thead><tbody>{exchangeOrders.length ? exchangeOrders.map((o, i) => <tr key={`${o.orderId}_${i}`}><td>{o.symbol}</td><td>{o.side}</td><td>{fmt(o.price, 4)}</td><td>{fmt(o.qty, 4)}</td><td>{o.status}</td><td>{fmtTs(o.createdTime)}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No exchange orders</td></tr>}</tbody></Table></div></Card.Body></Card></Col>
    </Row>}

    <Card><Card.Body><div className='d-flex align-items-center justify-content-between mb-2'><div className='fw-semibold'>Search (Top-50)</div><div className='d-flex gap-2'>{!isSearchRunning && <Button size='sm' disabled={status !== 'connected'} onClick={() => request('leadlag.search.start', {})}>Start search</Button>}{isSearchRunning && <Button size='sm' variant='outline-danger' disabled={status !== 'connected'} onClick={() => request('leadlag.search.stop', {})}>Stop search</Button>}</div></div><div className='small mb-1'>Phase: {String(progress.phase || searchStatus).toUpperCase()} · {progressDone}/{progressTotal} · Last update age: {lastSearchUpdateMs ? Math.max(0, Math.floor((Date.now() - lastSearchUpdateMs) / 1000)) : 0}s</div><div className='small text-muted mb-1'>Message: {searchMessage}</div>{searchError ? <div className='small text-warning mb-1'>{searchError}</div> : null}<ProgressBar now={progressPct} label={`${Math.round(progressPct)}%`} className='mb-2' /><Table size='sm' className='leadlag-search-table'><colgroup><col style={{ width: '9%' }} /><col style={{ width: '9%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '9%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '8%' }} /><col style={{ width: '25%' }} /></colgroup><thead><tr><th>Leader</th><th>Follower</th><th>Lag (ms)</th><th>Corr</th><th>Confirmations</th><th>Samples</th><th>Impulses</th><th>Confirmed</th><th>TradeReady</th><th>Blockers</th></tr></thead><tbody>{rows.map((r, idx) => { if (!r || typeof r !== 'object') return null; const blockers = Array.isArray(r?.blockers) ? r.blockers.slice(0, 3).map((b) => `${b?.key || 'BLOCK'}:${b?.detail || ''}`).join('; ') : '—'; return <tr key={`${r.leader}_${r.follower}_${idx}`}><td>{r.leader}</td><td>{r.follower}</td><td className='num'>{fmt(r.lagMs, 0)}</td><td className='num'>{fmt(r.corr, 3)}</td><td className='num'>{Number(r.confirmations || 0)}</td><td className='num'>{Number(r.samples || 0)}</td><td className='num'>{Number(r.impulses || 0)}</td><td><Badge bg={r.confirmed ? 'success' : 'secondary'}>{r.confirmed ? 'YES' : 'NO'}</Badge></td><td><Badge bg={r.tradeReady ? 'success' : 'warning'}>{r.tradeReady ? 'YES' : 'NO'}</Badge></td><td title={blockers}>{blockers}</td></tr>; })}</tbody></Table></Card.Body></Card>

  </div>;
}

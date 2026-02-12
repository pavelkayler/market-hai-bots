import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Nav, Row, Tab, Table } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

const fmtTs = (ts) => Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—';
const fmtPct = (x) => Number.isFinite(Number(x)) ? `${(Number(x) * 100).toFixed(2)}%` : '—';
const fmtUptime = (startedAt) => { const sec = Math.max(0, Math.floor((Date.now() - Number(startedAt || 0)) / 1000)); const h = String(Math.floor(sec / 3600)).padStart(2, '0'); const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0'); const s = String(sec % 60).padStart(2, '0'); return `${h}:${m}:${s}`; };
const WINDOW_OPTIONS = [
  { value: 300, label: '5m' },
  { value: 900, label: '15m' },
  { value: 1800, label: '30m' },
];

function windowLabel(sec) {
  if (Number(sec) === 300) return '5m';
  if (Number(sec) === 1800) return '30m';
  return '15m';
}

const applyArrayPatch = (prev, next, { allowEmptyReplace = false } = {}) => {
  if (!Array.isArray(next)) return prev;
  if (!next.length && Array.isArray(prev) && prev.length && !allowEmptyReplace) return prev;
  return next;
};

export default function ImpulsePage() {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('paper');
  const [settings, setSettings] = useState({ directionMode: 'AUTO', confirmA: true, confirmB: true, windowSec: 900 });

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg?.type === 'event' ? msg.topic : msg.type;
    const payload = msg?.payload;
    if (type === 'snapshot' && payload?.impulseState) {
      setState((prev) => {
        const next = { ...(prev || {}), ...(payload.impulseState || {}) };
        if (Array.isArray(payload.impulseState?.logs)) next.logs = applyArrayPatch(prev?.logs, payload.impulseState.logs);
        if (Array.isArray(payload.impulseState?.signals)) next.signals = applyArrayPatch(prev?.signals, payload.impulseState.signals);
        if (Array.isArray(payload.impulseState?.trades)) next.trades = applyArrayPatch(prev?.trades, payload.impulseState.trades);
        return next;
      });
      setSettings((prev) => ({
        ...prev,
        directionMode: payload.impulseState?.settings?.directionMode || prev.directionMode,
        confirmA: !!payload.impulseState?.settings?.confirmA,
        confirmB: !!payload.impulseState?.settings?.confirmB,
        windowSec: Number(payload.impulseState?.settings?.windowSec || 900),
      }));
    }
    if (type === 'impulse.state' || type === 'impulse.status') {
      setState((prev) => {
        const next = { ...(prev || {}), ...(payload || {}) };
        if (Array.isArray(payload?.logs)) next.logs = applyArrayPatch(prev?.logs, payload.logs, { allowEmptyReplace: payload?.clear === true });
        if (Array.isArray(payload?.signals)) next.signals = applyArrayPatch(prev?.signals, payload.signals, { allowEmptyReplace: payload?.clear === true });
        if (Array.isArray(payload?.trades)) next.trades = applyArrayPatch(prev?.trades, payload.trades, { allowEmptyReplace: payload?.clear === true });
        return next;
      });
      setSettings((prev) => ({
        ...prev,
        directionMode: payload?.settings?.directionMode || prev.directionMode,
        confirmA: !!payload?.settings?.confirmA,
        confirmB: !!payload?.settings?.confirmB,
        windowSec: Number(payload?.settings?.windowSec || 900),
      }));
    }
    if (type === 'impulse.log') setState((prev) => ({ ...(prev || {}), logs: [payload, ...(prev?.logs || [])].slice(0, 200) }));
    if (type === 'impulse.signal') setState((prev) => ({ ...(prev || {}), signals: [payload, ...(prev?.signals || [])].slice(0, 120) }));
    if (type === 'impulse.trade') setState((prev) => ({ ...(prev || {}), trades: [payload, ...(prev?.trades || [])].slice(0, 120) }));
  }, []);

  const { status, sendJson } = useWsClient({ onMessage, onOpen: () => sendJson({ type: 'getImpulseState' }) });


  const activeWindowSec = Number(state?.settings?.windowSec || settings.windowSec || 900);
  const activeWindowLabel = windowLabel(activeWindowSec);
  const signals = state?.signals || [];
  const logs = state?.logs || [];
  const trades = state?.trades || [];
  const processLogs = logs.filter((l) => /signal|no_trade|cooldown|confirm|scan|wait/i.test(String(l?.msg || '')));

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body className='d-grid gap-2'>
      <div className='d-flex justify-content-between'><strong>Impulse (Price+OI)</strong><Badge bg={status === 'connected' ? 'success' : 'secondary'}>{status}</Badge></div>
      <div className='d-flex justify-content-between'><span>Status</span><Badge bg={state?.status === 'RUNNING' ? 'success' : 'secondary'}>{state?.status || '—'}</Badge></div>{state?.status === 'RUNNING' ? <div className='text-muted'>Uptime {fmtUptime(state?.startedAt)}</div> : null}
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}><option value='paper'>PAPER</option><option value='demo'>DEMO</option><option value='real'>REAL</option></Form.Select>
      <Form.Select value={settings.directionMode} onChange={(e) => setSettings((p) => ({ ...p, directionMode: e.target.value }))}>
        <option value='AUTO'>AUTO</option><option value='MOMENTUM_ONLY'>MOMENTUM_ONLY</option><option value='COUNTERTREND_ONLY'>COUNTERTREND_ONLY</option>
      </Form.Select>
      <Form.Select value={settings.windowSec} onChange={(e) => {
        const nextWindowSec = Number(e.target.value);
        setSettings((p) => ({ ...p, windowSec: nextWindowSec }));
        sendJson({ type: 'impulse.setConfig', settings: { windowSec: nextWindowSec } });
      }}>
        {WINDOW_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{`Window: ${opt.label}`}</option>)}
      </Form.Select>
      <Form.Check label='Confirmation A (breakout)' checked={settings.confirmA} onChange={(e) => setSettings((p) => ({ ...p, confirmA: e.target.checked }))} />
      <Form.Check label='Confirmation B (retest)' checked={settings.confirmB} onChange={(e) => setSettings((p) => ({ ...p, confirmB: e.target.checked }))} />
      <div className='d-flex gap-2'><Button onClick={() => sendJson({ type: 'startImpulseBot', mode, settings })}>Start</Button><Button variant='outline-danger' onClick={() => sendJson({ type: 'stopImpulseBot' })}>Stop</Button></div>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      <Tab.Container defaultActiveKey='summary'><Nav variant='tabs' className='mb-3'>
        <Nav.Item><Nav.Link eventKey='summary'>Кратко</Nav.Link></Nav.Item>
        <Nav.Item><Nav.Link eventKey='detail'>Детально ({trades.length})</Nav.Link></Nav.Item>
        <Nav.Item><Nav.Link eventKey='logs'>Логи ({logs.length})</Nav.Link></Nav.Item>
        <Nav.Item><Nav.Link eventKey='process'>Process / Scanner ({processLogs.length})</Nav.Link></Nav.Item>
      </Nav><Tab.Content>
        <Tab.Pane eventKey='summary'>
          <div className='mb-2'><b>Summary</b>: signals {signals.length} | active {state?.activePositions?.length || 0} | cooldown {Object.keys(state?.cooldownsBySymbol || {}).length}</div>
          <Table size='sm'><thead><tr><th>Symbol</th><th>Side</th><th>{`Δ${activeWindowLabel}`}</th><th>{`OI Δ${activeWindowLabel}`}</th><th>Time</th></tr></thead><tbody>
            {signals.slice(0, 30).map((s, i) => <tr key={i}><td>{s.symbol}</td><td>{s.side}</td><td>{fmtPct(s.priceDeltaPct ?? s.priceDelta15m)}</td><td>{fmtPct(s.oiDeltaPct ?? s.oiDelta15m)}</td><td>{fmtTs(s.ts)}</td></tr>)}
          </tbody></Table>
        </Tab.Pane>
        <Tab.Pane eventKey='detail'><Table size='sm'><tbody>{trades.length ? trades.map((t, i) => <tr key={i}><td>{fmtTs(t.ts)}</td><td>{t.symbol}</td><td>{t.side}</td><td>{t.event}</td><td>{fmtPct((Number(t.roiPct) || 0) / 100)}</td></tr>) : <tr><td className='text-muted'>No trades yet</td></tr>}</tbody></Table></Tab.Pane>
        <Tab.Pane eventKey='logs'><div style={{ maxHeight: 320, overflow: 'auto' }}><Table size='sm'><tbody>{logs.slice(0, 120).map((l, i) => <tr key={i}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>)}</tbody></Table></div></Tab.Pane>
        <Tab.Pane eventKey='process'><div style={{ maxHeight: 320, overflow: 'auto' }}><Table size='sm'><tbody>{processLogs.length ? processLogs.map((l, i) => <tr key={i}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>) : <tr><td className='text-muted'>No scanner logs yet</td></tr>}</tbody></Table></div></Tab.Pane>
      </Tab.Content></Tab.Container>
    </Card.Body></Card></Col>
  </Row>;
}

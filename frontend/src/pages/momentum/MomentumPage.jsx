import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const DEFAULT_FORM = {
  mode: 'paper', directionMode: 'BOTH', windowMinutes: 1, priceThresholdPct: 5, oiThresholdPct: 1,
  turnover24hMin: 5000000, vol24hMin: 0.1, leverage: 10, marginUsd: 100, tpRoiPct: 10, slRoiPct: 10,
  entryOffsetPct: -0.01, turnoverSpikePct: 100, baselineFloorUSDT: 100000, holdSeconds: 3, trendConfirmSeconds: 3, oiMaxAgeSec: 10,
  globalSymbolLock: false,
};

export default function MomentumPage() {
  const ws = useWs();
  const [market, setMarket] = useState(null);
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [trades, setTrades] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    const unsub = ws.subscribe((_, parsed) => {
      if (parsed?.type !== 'event') return;
      if (parsed.topic === 'momentum.state') {
        setMarket(parsed.payload?.market || null);
        setInstances(parsed.payload?.instances || []);
      }
    });
    ws.subscribeTopics(['momentum.*']);
    return () => { unsub(); ws.unsubscribeTopics(['momentum.*']); };
  }, [ws]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const st = await ws.request('momentum.list', {});
      if (st?.ok) setInstances(st.instances || []);
      const ms = await ws.request('momentum.getMarketStatus', {});
      if (ms?.ok) setMarket(ms);
      if (selectedId) {
        const d = await ws.request('momentum.getState', { instanceId: selectedId });
        if (d?.ok) setDetail(d.stateSnapshot);
        const t = await ws.request('momentum.getTrades', { instanceId: selectedId, limit: 50, offset: 0 });
        if (t?.ok) setTrades(t.trades || []);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [ws, selectedId]);

  const options = useMemo(() => instances.map((i) => <option key={i.id} value={i.id}>{i.id}</option>), [instances]);

  async function onStart(e) {
    e.preventDefault();
    const nextErrors = {};
    const numFields = ['entryOffsetPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec'];
    const nextConfig = { ...form, windowMinutes: Number(form.windowMinutes) };
    for (const k of numFields) {
      const n = Number(nextConfig[k]);
      if (!Number.isFinite(n)) nextErrors[k] = `${k} must be a valid number.`;
      else nextConfig[k] = n;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const out = await ws.request('momentum.start', { config: nextConfig });
    if (out?.ok && out.instanceId) setSelectedId(out.instanceId);
  }

  async function onCancelEntry(symbol) {
    if (!selectedId) return;
    await ws.request('momentum.cancelEntry', { instanceId: selectedId, symbol });
  }

  return <Row className="g-3">
    <Col md={12}><Card><Card.Body><Card.Title>Market status</Card.Title>
      {!market && <Alert variant="secondary">Loading...</Alert>}
      {market?.lastHedgeModeError && <Alert variant="danger" className="mb-2">{market.lastHedgeModeError}</Alert>}
      {market?.lastMarginModeError && <Alert variant="warning" className="mb-2">{market.lastMarginModeError}</Alert>}
      {market && <div>WS: {String(market.wsConnected)} | Universe: {market.universeCount} | Eligible: {market.eligibleCount} | Subscribed: {market.subscribedCount}/{market.cap} | Kline topics: {market.klineSubscribedCount || 0} | Active intervals: {(market.activeIntervals || []).join(', ') || '-'} | Drift: {market.tickDriftMs}ms | Hedge: {market.hedgeMode || 'UNKNOWN'} | Margin: {market.marginMode || 'UNKNOWN'}</div>}
    </Card.Body></Card></Col>
    <Col md={4}><Card><Card.Body><Card.Title>Create new bot instance</Card.Title>
      <Form onSubmit={onStart}>
        <Form.Select className="mb-2" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="paper">paper</option><option value="demo">demo</option><option value="real">real</option></Form.Select>
        <Form.Select className="mb-2" value={form.directionMode} onChange={(e) => setForm({ ...form, directionMode: e.target.value })}><option value="BOTH">BOTH</option><option value="LONG">LONG</option><option value="SHORT">SHORT</option></Form.Select>
        <Form.Group className="mb-2">
          <Form.Label>Window (minutes)</Form.Label>
          <Form.Select value={form.windowMinutes} onChange={(e) => setForm({ ...form, windowMinutes: Number(e.target.value) })}>
            <option value={1}>1</option><option value={3}>3</option><option value={5}>5</option>
          </Form.Select>
        </Form.Group>
        {['priceThresholdPct', 'oiThresholdPct', 'turnover24hMin', 'vol24hMin', 'tpRoiPct', 'slRoiPct'].map((k) => <Form.Control key={k} className="mb-2" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={k} />)}
        {['entryOffsetPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec'].map((k) => <Form.Control key={k} className="mb-2" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={k} isInvalid={Boolean(errors[k])} />)}
        <Form.Check className="mb-2" checked={form.globalSymbolLock} onChange={(e) => setForm({ ...form, globalSymbolLock: e.target.checked })} label="Global symbol lock" />
        <Button type="submit">Start</Button>
      </Form>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body><Card.Title>Running bots</Card.Title>
      <Table size="sm"><thead><tr><th>ID</th><th>Mode</th><th>Direction</th><th>W</th><th>Offset</th><th>Turnover gate</th><th>Hedge</th><th>Margin</th><th>Uptime</th><th>Trades</th><th>PNL</th><th /></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id.slice(0, 12)}</td><td>{i.mode}</td><td>{i.direction}</td><td>{i.windowMinutes}m</td><td>{Number(i.entryOffsetPct || 0)}%</td><td>{Number(i.turnoverSpikePct || 100)}%</td><td>{i.hedgeMode || 'UNKNOWN'}</td><td>{i.marginMode || 'UNKNOWN'}</td><td>{i.uptimeSec}s</td><td>{i.trades}</td><td>{Number(i.pnl || 0).toFixed(2)}</td><td><Button size="sm" variant="outline-danger" onClick={() => ws.request('momentum.stop', { instanceId: i.id })}>Stop</Button></td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
    <Col md={12}><Card><Card.Body><Card.Title>Selected instance details</Card.Title>
      <Form.Select className="mb-2" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">Select...</option>{options}</Form.Select>
      {detail && <div>Open positions: {detail.openPositions?.length || 0} | Pending triggers: {detail.pendingOrders?.length || 0} | W: {detail?.config?.windowMinutes}m | Hedge: {detail?.hedgeMode || 'UNKNOWN'} | Margin: {detail?.marginMode || 'UNKNOWN'}</div>}

      {detail && <><h6>Open Orders / Pending Triggers</h6><Table size="sm" className="mt-2"><thead><tr><th>Symbol</th><th>State</th><th>Side</th><th>Trigger</th><th>Created</th><th>Age</th><th>Actions</th></tr></thead><tbody>
        {(detail.pendingOrders || []).map((p) => <tr key={`pending_${p.symbol}`}><td>{p.symbol}</td><td>TRIGGER_PENDING</td><td>{p.side}</td><td>{p.triggerPrice}</td><td>{new Date(p.createdAtMs).toLocaleTimeString()}</td><td>{p.ageSec}s</td><td><Button size="sm" variant="outline-warning" onClick={() => onCancelEntry(p.symbol)}>Cancel entry</Button></td></tr>)}
        {(detail.openPositions || []).map((p) => <tr key={`pos_${p.symbol}`}><td>{p.symbol}</td><td>IN_POSITION</td><td>{p.side}</td><td>{p.entryPrice}</td><td>-</td><td>-</td><td>-</td></tr>)}
      </tbody></Table></>}

      {detail?.logs?.length > 0 && <Table size="sm"><thead><tr><th>Time</th><th>Message</th></tr></thead><tbody>
        {detail.logs.map((l, idx) => <tr key={`${l.ts}_${idx}`}><td>{new Date(l.ts).toLocaleTimeString()}</td><td>{`${l.msg}${l.symbol ? `: ${l.symbol}` : ''}`}</td></tr>)}
      </tbody></Table>}

      <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th>Trigger</th><th>Entry</th><th>Exit</th><th>Offset</th><th>Outcome</th><th>PNL</th></tr></thead><tbody>{trades.map((t) => <tr key={t.id}><td>{t.symbol}</td><td>{t.side}</td><td>{t.triggerPrice}</td><td>{t.entryPrice}</td><td>{t.exitPrice}</td><td>{Number(t.entryOffsetPct || 0)}%</td><td>{t.outcome}</td><td>{Number(t.pnlUsd || 0).toFixed(3)}</td></tr>)}</tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

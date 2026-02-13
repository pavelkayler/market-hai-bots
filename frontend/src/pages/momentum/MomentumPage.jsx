import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const DEFAULT_FORM = { mode: 'paper', directionMode: 'BOTH', windowMinutes: 1, priceThresholdPct: 5, oiThresholdPct: 1, turnover24hMin: 5000000, vol24hMin: 0.1, leverage: 10, marginUsd: 100, tpRoiPct: 10, slRoiPct: 10, globalSymbolLock: false };

export default function MomentumPage() {
  const ws = useWs();
  const [market, setMarket] = useState(null);
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [trades, setTrades] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);

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
    const out = await ws.request('momentum.start', { config: form });
    if (out?.ok && out.instanceId) setSelectedId(out.instanceId);
  }

  return <Row className="g-3">
    <Col md={12}><Card><Card.Body><Card.Title>Market status</Card.Title>
      {!market && <Alert variant="secondary">Loading...</Alert>}
      {market && <div>WS: {String(market.wsConnected)} | Universe: {market.universeCount} | Eligible: {market.eligibleCount} | Subscribed: {market.subscribedCount}/{market.cap} | Drift: {market.tickDriftMs}ms</div>}
    </Card.Body></Card></Col>
    <Col md={4}><Card><Card.Body><Card.Title>Create new bot instance</Card.Title>
      <Form onSubmit={onStart}>
        <Form.Select className="mb-2" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="paper">paper</option><option value="demo">demo</option><option value="real">real</option></Form.Select>
        <Form.Select className="mb-2" value={form.directionMode} onChange={(e) => setForm({ ...form, directionMode: e.target.value })}><option value="BOTH">BOTH</option><option value="LONG">LONG</option><option value="SHORT">SHORT</option></Form.Select>
        {['windowMinutes','priceThresholdPct','oiThresholdPct','turnover24hMin','vol24hMin'].map((k) => <Form.Control key={k} className="mb-2" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={k} />)}
        <Form.Check className="mb-2" checked={form.globalSymbolLock} onChange={(e) => setForm({ ...form, globalSymbolLock: e.target.checked })} label="Global symbol lock" />
        <Button type="submit">Start</Button>
      </Form>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body><Card.Title>Running bots</Card.Title>
      <Table size="sm"><thead><tr><th>ID</th><th>Mode</th><th>Direction</th><th>Uptime</th><th>Trades</th><th>PNL</th><th /></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id.slice(0,12)}</td><td>{i.mode}</td><td>{i.direction}</td><td>{i.uptimeSec}s</td><td>{i.trades}</td><td>{Number(i.pnl || 0).toFixed(2)}</td><td><Button size="sm" variant="outline-danger" onClick={() => ws.request('momentum.stop', { instanceId: i.id })}>Stop</Button></td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
    <Col md={12}><Card><Card.Body><Card.Title>Selected instance details</Card.Title>
      <Form.Select className="mb-2" value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">Select...</option>{options}</Form.Select>
      {detail && <div>Open positions: {detail.openPositions?.length || 0} | Pending: {detail.pendingOrders?.length || 0}</div>}
      <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Outcome</th><th>PNL</th></tr></thead><tbody>{trades.map((t) => <tr key={t.id}><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryPrice}</td><td>{t.exitPrice}</td><td>{t.outcome}</td><td>{Number(t.pnlUsd || 0).toFixed(3)}</td></tr>)}</tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

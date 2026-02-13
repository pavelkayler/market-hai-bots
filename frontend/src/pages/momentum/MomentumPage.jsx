import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, InputGroup, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const DEFAULT_FORM = {
  mode: 'paper', directionMode: 'BOTH', windowMinutes: 1, priceThresholdPct: 5, oiThresholdPct: 1,
  turnover24hMin: 5000000, vol24hMin: 0.1, leverage: 10, marginUsd: 100, tpRoiPct: 10, slRoiPct: 10,
  entryOffsetPct: -0.01, turnoverSpikePct: 100, baselineFloorUSDT: 100000, holdSeconds: 3, trendConfirmSeconds: 3, oiMaxAgeSec: 10,
  globalSymbolLock: false,
};

const numericFieldDefs = [
  { key: 'turnover24hMin', label: 'Min 24h turnover', unit: 'USDT', placeholder: '5000000', help: 'Filter by liquidity.' },
  { key: 'vol24hMin', label: 'Min 24h volatility', unit: '%', placeholder: '0.1', help: '24h volatility threshold.' },
  { key: 'priceThresholdPct', label: 'Price change threshold over W', unit: '%', placeholder: '5' },
  { key: 'oiThresholdPct', label: 'OI value change threshold over W', unit: '%', placeholder: '1' },
  { key: 'marginUsd', label: 'Margin per trade', unit: 'USDT', placeholder: '100' },
  { key: 'leverage', label: 'Leverage', unit: 'x', placeholder: '10' },
  { key: 'tpRoiPct', label: 'Take profit (ROI)', unit: '%', placeholder: '10' },
  { key: 'slRoiPct', label: 'Stop loss (ROI)', unit: '%', placeholder: '10' },
  { key: 'entryOffsetPct', label: 'Entry trigger offset from price source', unit: '%', placeholder: '-0.01' },
  { key: 'turnoverSpikePct', label: 'Turnover spike required (LONG only)', unit: '%', placeholder: '100' },
  { key: 'baselineFloorUSDT', label: 'Min turnover baseline floor', unit: 'USDT', placeholder: '100000' },
  { key: 'holdSeconds', label: 'Conditions must hold', unit: 'sec', placeholder: '3' },
  { key: 'trendConfirmSeconds', label: 'Trend confirm (same-direction ticks)', unit: 'sec', placeholder: '3' },
  { key: 'oiMaxAgeSec', label: 'Max OI staleness', unit: 'sec', placeholder: '10' },
];

export default function MomentumPage() {
  const ws = useWs();
  const [market, setMarket] = useState(null);
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [trades, setTrades] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});
  const [tradePage, setTradePage] = useState(0);
  const tradePageSize = 50;
  const [tradeTotal, setTradeTotal] = useState(0);

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
        const t = await ws.request('momentum.getTrades', { instanceId: selectedId, limit: tradePageSize, offset: tradePage * tradePageSize });
        if (t?.ok) { setTrades(t.trades || []); setTradeTotal(Number(t.total || 0)); }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [ws, selectedId, tradePage]);

  const options = useMemo(() => instances.map((i) => <option key={i.id} value={i.id}>{i.id}</option>), [instances]);

  async function onStart(e) {
    e.preventDefault();
    const nextErrors = {};
    const numFields = numericFieldDefs.map((x) => x.key);
    const nextConfig = { ...form, windowMinutes: Number(form.windowMinutes) };
    for (const k of numFields) {
      const n = Number(nextConfig[k]);
      if (!Number.isFinite(n)) nextErrors[k] = `${k} must be a valid number.`;
      else nextConfig[k] = n;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const out = await ws.request('momentum.start', { config: nextConfig });
    if (out?.ok && out.instanceId) { setSelectedId(out.instanceId); setTradePage(0); }
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

    <Col md={5}><Card><Card.Body><Card.Title>Create new bot instance</Card.Title>
      <Form onSubmit={onStart}>
        <Form.Group className="mb-2"><Form.Label>Execution mode</Form.Label>
          <Form.Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}><option value="paper">Paper</option><option value="demo">Demo</option><option value="real">Real</option></Form.Select>
        </Form.Group>
        <Form.Group className="mb-2"><Form.Label>Direction</Form.Label>
          <Form.Select value={form.directionMode} onChange={(e) => setForm({ ...form, directionMode: e.target.value })}><option value="BOTH">BOTH</option><option value="LONG">LONG</option><option value="SHORT">SHORT</option></Form.Select>
        </Form.Group>
        <Form.Group className="mb-2"><Form.Label>Lookback window (minutes)</Form.Label>
          <InputGroup><Form.Select value={form.windowMinutes} onChange={(e) => setForm({ ...form, windowMinutes: Number(e.target.value) })}><option value={1}>1</option><option value={3}>3</option><option value={5}>5</option></Form.Select><InputGroup.Text>min</InputGroup.Text></InputGroup>
        </Form.Group>
        {numericFieldDefs.map((field) => <Form.Group className="mb-2" key={field.key}><Form.Label>{field.label}</Form.Label><InputGroup><Form.Control value={form[field.key]} onChange={(e) => setForm({ ...form, [field.key]: e.target.value })} isInvalid={Boolean(errors[field.key])} placeholder={field.placeholder} /><InputGroup.Text>{field.unit}</InputGroup.Text></InputGroup>{field.help ? <Form.Text muted>{field.help}</Form.Text> : null}</Form.Group>)}
        <Form.Check className="mb-2" checked={form.globalSymbolLock} onChange={(e) => setForm({ ...form, globalSymbolLock: e.target.checked })} label="Global symbol lock" />
        <Form.Text className="d-block mb-2" muted>Defaults: entry offset -0.01%, turnover spike 100%.</Form.Text>
        <Button type="submit">Start</Button>
      </Form>
    </Card.Body></Card></Col>

    <Col md={7}><Card><Card.Body><Card.Title>Running bots</Card.Title>
      <Table size="sm"><thead><tr><th>ID</th><th>Mode</th><th>Direction</th><th>W</th><th>Offset</th><th>Turnover gate</th><th>Hedge</th><th>Margin</th><th>Isolated preflight</th><th>Uptime</th><th>Trades</th><th>PNL</th><th /></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id.slice(0, 12)}</td><td>{i.mode}</td><td>{i.direction}</td><td>{i.windowMinutes}m</td><td>{Number(i.entryOffsetPct || 0)}%</td><td>{Number(i.turnoverSpikePct || 100)}%</td><td>{i.hedgeMode || 'UNKNOWN'}</td><td>{i.marginMode || 'UNKNOWN'}</td><td>{i.isolatedPreflightOk ? 'OK' : (i.isolatedPreflightError || 'N/A')}</td><td>{i.uptimeSec}s</td><td>{i.trades}</td><td>{Number(i.pnl || 0).toFixed(2)}</td><td><Button size="sm" variant="outline-danger" onClick={() => ws.request('momentum.stop', { instanceId: i.id })}>Stop</Button></td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>

    <Col md={12}><Card><Card.Body><Card.Title>Selected instance details</Card.Title>
      <Form.Select className="mb-2" value={selectedId} onChange={(e) => { setSelectedId(e.target.value); setTradePage(0); }}><option value="">Select...</option>{options}</Form.Select>
      {detail && <div>Open positions: {detail.openPositions?.length || 0} | Pending triggers: {detail.pendingOrders?.length || 0} | W: {detail?.config?.windowMinutes}m | Hedge: {detail?.hedgeMode || 'UNKNOWN'} | Margin desired: {detail?.marginModeDesired || 'ISOLATED'} | Isolated preflight: {detail?.isolatedPreflightOk ? 'OK' : (detail?.isolatedPreflightError || 'N/A')} | Trades: {detail?.stats?.trades || 0} | Wins: {detail?.stats?.wins || 0} | Losses: {detail?.stats?.losses || 0} | Winrate: {(detail?.stats?.trades ? ((detail.stats.wins / detail.stats.trades) * 100) : 0).toFixed(1)}% | PnL: {Number(detail?.stats?.pnl || 0).toFixed(2)} | Fees: {Number(detail?.stats?.fees || 0).toFixed(2)}</div>}

      {detail && <><h6>Open Orders / Pending Triggers</h6><Table size="sm" className="mt-2"><thead><tr><th>Symbol</th><th>State</th><th>Side</th><th>Trigger/Entry</th><th>TP/SL</th><th>TP/SL Status</th><th>Created</th><th>Age</th><th>Actions</th></tr></thead><tbody>
        {(detail.pendingOrders || []).map((p) => <tr key={`pending_${p.symbol}`}><td>{p.symbol}</td><td>TRIGGER_PENDING</td><td>{p.side}</td><td>{p.triggerPrice}</td><td>-</td><td>-</td><td>{new Date(p.createdAtMs).toLocaleTimeString()}</td><td>{p.ageSec}s</td><td><Button size="sm" variant="outline-warning" onClick={() => onCancelEntry(p.symbol)}>Cancel entry</Button></td></tr>)}
        {(detail.openPositions || []).map((p) => <tr key={`pos_${p.symbol}`}><td>{p.symbol}</td><td>IN_POSITION</td><td>{p.side}</td><td>{p.entryPriceActual || p.entryPrice}</td><td>{p.tpPrice} / {p.slPrice}</td><td>{p.tpSlStatus || 'PENDING'}</td><td>-</td><td>-</td><td>-</td></tr>)}
      </tbody></Table></>}

      {detail?.logs?.length > 0 && <Table size="sm"><thead><tr><th>Time</th><th>Message</th></tr></thead><tbody>
        {detail.logs.map((l, idx) => <tr key={`${l.ts}_${idx}`}><td>{new Date(l.ts).toLocaleTimeString()}</td><td>{`${l.msg}${l.symbol ? `: ${l.symbol}` : ''}`}</td></tr>)}
      </tbody></Table>}

      <div className="d-flex gap-2 align-items-center mb-2"><Button size="sm" variant="outline-secondary" disabled={tradePage <= 0} onClick={() => setTradePage((p) => Math.max(0, p - 1))}>Prev</Button><Button size="sm" variant="outline-secondary" disabled={(tradePage + 1) * tradePageSize >= tradeTotal} onClick={() => setTradePage((p) => p + 1)}>Next</Button><span>Page {tradePage + 1} / {Math.max(1, Math.ceil(tradeTotal / tradePageSize))}</span></div>
      <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th>Trigger</th><th>Entry</th><th>TP / SL</th><th>Offset</th><th>Outcome</th><th>PNL</th></tr></thead><tbody>{trades.map((t) => <tr key={t.id}><td>{t.symbol}</td><td>{t.side}</td><td>{t.triggerPrice}</td><td>{t.entryPriceActual || t.actualEntryPrice || t.entryPrice || 'pending'}{!(t.entryPriceActual > 0 || t.actualEntryPrice > 0) ? <Badge bg="warning" text="dark" className="ms-2">unconfirmed</Badge> : null}</td><td>{t.tpPrice || '-'} / {t.slPrice || '-'}</td><td>{Number(t.entryOffsetPct || 0)}%</td><td>{t.outcome}</td><td>{Number(t.pnlUsd || 0).toFixed(3)}</td></tr>)}</tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

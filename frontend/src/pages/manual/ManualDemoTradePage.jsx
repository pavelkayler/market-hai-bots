import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const MANUAL_DEMO_MAX_NOTIONAL_USDT = Number(import.meta.env.VITE_MANUAL_DEMO_MAX_NOTIONAL_USDT || 5000);
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(4) : '-');

const sideOf = (p) => String(p?.side || p?.positionSide || '').toUpperCase();

function resolveTp(position, orders = []) {
  if (Number(position?.takeProfit || 0) > 0) return Number(position.takeProfit);
  const side = sideOf(position);
  const opposite = side === 'BUY' || side === 'LONG' ? ['SELL', 'SHORT'] : ['BUY', 'LONG'];
  const entry = Number(position?.avgPrice || position?.entryPrice || 0);
  const cand = orders.filter((o) => Boolean(o?.reduceOnly) && opposite.includes(String(o?.side || '').toUpperCase()));
  const best = cand.find((o) => side === 'LONG' || side === 'BUY' ? Number(o?.price || 0) > entry : Number(o?.price || 0) < entry) || cand[0];
  return Number(best?.price || 0) || null;
}

export default function ManualDemoTradePage() {
  const ws = useWs();
  const [symbols, setSymbols] = useState([]);
  const [form, setForm] = useState({ symbol: 'BTCUSDT', side: 'LONG', marginUSDT: 100, leverage: 10, tpRoiPct: 5, slRoiPct: 5 });
  const [state, setState] = useState({ position: null, orders: [], quote: null });
  const [lastAction, setLastAction] = useState(null);

  const refresh = useCallback(async (symbol) => {
    const [out, quote] = await Promise.all([ws.request('manual.getDemoState', { symbol }), ws.request('manual.getQuote', { symbol })]);
    if (out?.ok) setState({ position: out.position, orders: out.orders || [], quote });
  }, [ws]);

  useEffect(() => { fetch(`${API_BASE}/api/universe/list`).then((r) => r.json()).then((d) => setSymbols(d.symbols || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!form.symbol) return;
    refresh(form.symbol);
    const timer = setInterval(() => refresh(form.symbol), 1500);
    return () => clearInterval(timer);
  }, [form.symbol, refresh]);

  const preview = useMemo(() => {
    const px = Number(state.quote?.markPrice || state.quote?.lastPrice || state.position?.markPrice || state.position?.avgPrice || 0);
    const qty = px > 0 ? (Number(form.marginUSDT) * Number(form.leverage)) / px : 0;
    return { px, qty, notional: qty * px };
  }, [form, state]);

  const position = state.position;
  const tp = resolveTp(position, state.orders);

  return <Row className='g-3'>
    <Col md={5}><Card><Card.Body><Card.Title>Manual DEMO order</Card.Title>
      <Form.Group className='mb-2'><Form.Label>Symbol</Form.Label><Form.Select value={form.symbol} onChange={(e) => setForm((p) => ({ ...p, symbol: e.target.value }))}>{symbols.map((s) => <option key={s}>{s}</option>)}</Form.Select></Form.Group>
      <Form.Group className='mb-2'><Form.Label>Side</Form.Label><Form.Select value={form.side} onChange={(e) => setForm((p) => ({ ...p, side: e.target.value }))}><option>LONG</option><option>SHORT</option></Form.Select></Form.Group>
      {['marginUSDT', 'leverage', 'tpRoiPct', 'slRoiPct'].map((k) => <Form.Group className='mb-2' key={k}><Form.Label>{k}</Form.Label><Form.Control type='number' value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: Number(e.target.value) }))} /></Form.Group>)}
      <div className='mb-2 text-muted'>MARK/LAST: {preview.px || '-'} | qty: {preview.qty.toFixed(4)} | notional: {preview.notional.toFixed(2)} | limit: {MANUAL_DEMO_MAX_NOTIONAL_USDT}</div>
      <Button onClick={async () => { const out = await ws.request('manual.placeDemoOrder', form); setLastAction(out); if (out?.createdTpOrders?.length === 0) alert('TP orders were not created'); refresh(form.symbol); }}>Разместить ордер</Button>
      {lastAction?.error && <Alert variant='danger' className='mt-2'>{lastAction.error}</Alert>}
    </Card.Body></Card></Col>

    <Col md={7}><Card><Card.Body>
      <Card.Title>Positions</Card.Title>
      <Table size='sm'><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>AvgPrice</th><th>MarkPrice</th><th>LiqPrice</th><th>PnL</th><th>SL</th><th>TP</th><th>Actions</th></tr></thead><tbody>
        <tr><td>{form.symbol}</td><td>{sideOf(position) || '-'}</td><td>{fmt(position?.size || position?.qty)}</td><td>{fmt(position?.avgPrice || position?.entryPrice)}</td><td>{fmt(position?.markPrice || state.quote?.markPrice)}</td><td>{fmt(position?.liqPrice)}</td><td>{fmt(position?.unrealisedPnl || position?.unrealizedPnl)}</td><td>{fmt(position?.stopLoss)}</td><td>{fmt(tp)}</td><td><Button size='sm' variant='warning' onClick={async () => { setLastAction(await ws.request('manual.closeDemoPosition', { symbol: form.symbol })); refresh(form.symbol); }}>Закрыть позицию (Market)</Button></td></tr>
      </tbody></Table>

      <h6 className='mt-3'>Open Orders</h6>
      <Table size='sm'><thead><tr><th>orderId</th><th>side</th><th>price</th><th>qty</th><th>leavesQty</th><th>status</th><th>reduceOnly</th><th>createdTime</th></tr></thead><tbody>
        {[...(state.orders || [])].sort((a, b) => Number(b.createdTime || 0) - Number(a.createdTime || 0)).map((o) => <tr key={o.orderId || `${o.side}-${o.price}`}><td>{o.orderId || '-'}</td><td>{o.side}</td><td>{fmt(o.price)}</td><td>{fmt(o.qty)}</td><td>{fmt(o.leavesQty)}</td><td>{o.orderStatus || o.status || '-'}</td><td>{String(Boolean(o.reduceOnly))}</td><td>{o.createdTime ? new Date(Number(o.createdTime)).toLocaleString() : '-'}</td></tr>)}
      </tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

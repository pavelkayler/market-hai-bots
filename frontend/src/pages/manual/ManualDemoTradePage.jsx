import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const MANUAL_DEMO_MAX_NOTIONAL_USDT = Number(import.meta.env.VITE_MANUAL_DEMO_MAX_NOTIONAL_USDT || 5000);

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(4) : '-');
const shortId = (v) => String(v || '-').slice(0, 8);
const sideOfPosition = (p) => String(p?.side || p?.positionSide || '').toUpperCase();

function resolveTpFromOrders(position, orders = []) {
  const posSide = sideOfPosition(position);
  const posQty = Math.abs(Number(position?.size || position?.qty || 0));
  const entry = Number(position?.avgPrice || position?.entryPrice || 0);
  if (!posSide || !posQty || !entry) return null;
  const opposite = posSide === 'BUY' || posSide === 'LONG' ? ['SELL', 'SHORT'] : ['BUY', 'LONG'];
  const cands = orders.filter((o) => Boolean(o?.reduceOnly) && opposite.includes(String(o?.side || '').toUpperCase()));
  cands.sort((a, b) => Math.abs(Number(a?.leavesQty || a?.qty || 0) - posQty) - Math.abs(Number(b?.leavesQty || b?.qty || 0) - posQty));
  return cands.find((o) => (posSide === 'BUY' || posSide === 'LONG') ? Number(o?.price || 0) > entry : Number(o?.price || 0) < entry) || null;
}

export default function ManualDemoTradePage() {
  const ws = useWs();
  const [symbols, setSymbols] = useState([]);
  const [form, setForm] = useState({ symbol: 'BTCUSDT', side: 'LONG', marginUSDT: 100, leverage: 10, tpRoiPct: 5, slRoiPct: 5 });
  const [state, setState] = useState({ position: null, orders: [], quote: null });
  const [lastAction, setLastAction] = useState(null);

  const refresh = useCallback(async (symbol) => {
    const [out, quote] = await Promise.all([ws.request('manual.getDemoState', { symbol }), ws.request('manual.getQuote', { symbol })]);
    if (out?.ok) setState({ position: out.position, orders: out.orders, quote });
  }, [ws]);

  useEffect(() => { fetch(`${API_BASE}/api/universe/list`).then((r) => r.json()).then((d) => setSymbols(d.symbols || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!form.symbol) return;
    const once = setTimeout(() => { refresh(form.symbol); }, 0);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(form.symbol); }, 1500);
    return () => { clearTimeout(once); clearInterval(timer); };
  }, [form.symbol, refresh]);

  const preview = useMemo(() => {
    const px = Number(state.quote?.markPrice || state.quote?.lastPrice || state.position?.markPrice || state.position?.avgPrice || 0);
    const qty = px > 0 ? (Number(form.marginUSDT) * Number(form.leverage)) / px : 0;
    return { px, qty, notional: qty * px };
  }, [form, state.position, state.quote]);

  const tpOrder = resolveTpFromOrders(state.position, state.orders);
  return <Row className='g-3'>
    <Col md={6}><Card><Card.Body><Card.Title>Manual DEMO order</Card.Title>
      <Form.Group className='mb-2'><Form.Label>Symbol</Form.Label><Form.Select value={form.symbol} onChange={(e) => setForm((p) => ({ ...p, symbol: e.target.value }))}>{symbols.map((s) => <option key={s}>{s}</option>)}</Form.Select></Form.Group>
      <Form.Group className='mb-2'><Form.Label>Side</Form.Label><Form.Select value={form.side} onChange={(e) => setForm((p) => ({ ...p, side: e.target.value }))}><option>LONG</option><option>SHORT</option></Form.Select></Form.Group>
      {['marginUSDT', 'leverage', 'tpRoiPct', 'slRoiPct'].map((k) => <Form.Group className='mb-2' key={k}><Form.Label>{k}</Form.Label><Form.Control type='number' value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: Number(e.target.value) }))} /></Form.Group>)}
      <div className='mb-2 text-muted'>MARK/LAST: {preview.px || '-'} | qty: {preview.qty.toFixed(4)} | notional: {preview.notional.toFixed(2)} | limit: {MANUAL_DEMO_MAX_NOTIONAL_USDT}</div>
      <Button onClick={async () => { setLastAction(await ws.request('manual.placeDemoOrder', form)); refresh(form.symbol); }}>Разместить ордер</Button>
    </Card.Body></Card></Col>

    <Col md={6}><Card><Card.Body><Card.Title>Position</Card.Title>
      <Table size='sm'><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>TP</th><th>SL</th><th>Action</th></tr></thead><tbody>
        <tr><td>{form.symbol}</td><td>{sideOfPosition(state.position) || '-'}</td><td>{fmt(state.position?.size || state.position?.qty)}</td><td>{fmt(state.position?.avgPrice || state.position?.entryPrice)}</td><td>{Number(state.position?.takeProfit || 0) > 0 ? fmt(state.position?.takeProfit) : (tpOrder ? `TP(order): ${fmt(tpOrder.price)}` : '-')}</td><td>{fmt(state.position?.stopLoss)}</td><td><Button size='sm' variant='warning' onClick={async () => { setLastAction(await ws.request('manual.closeDemoPosition', { symbol: form.symbol })); refresh(form.symbol); }}>Закрыть позицию (Market)</Button></td></tr>
      </tbody></Table>
      <h6 className='mt-3'>Open Orders</h6>
      <Table size='sm'><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Price</th><th>Qty</th><th>LeavesQty</th><th>ReduceOnly</th><th>Status</th><th>Created</th><th>OrderId</th></tr></thead><tbody>
        {[...(state.orders || [])].sort((a, b) => Number(b.createdTime || 0) - Number(a.createdTime || 0)).map((o) => <tr key={o.orderId || `${o.side}-${o.price}`}><td>{o.symbol || form.symbol}</td><td>{o.side}</td><td>{o.orderType || o.type || 'Limit'}</td><td>{fmt(o.price)}</td><td>{fmt(o.qty)}</td><td>{fmt(o.leavesQty)}</td><td>{String(Boolean(o.reduceOnly))}</td><td>{o.orderStatus || o.status || '-'}</td><td>{o.createdTime ? new Date(Number(o.createdTime)).toLocaleString() : '-'}</td><td>{shortId(o.orderId)}</td></tr>)}
      </tbody></Table>
      <div>Status: <pre className='mb-0'>{JSON.stringify(lastAction, null, 2)}</pre></div>
    </Card.Body></Card></Col>
  </Row>;
}

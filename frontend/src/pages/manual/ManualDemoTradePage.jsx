import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

export default function ManualDemoTradePage() {
  const ws = useWs();
  const [symbols, setSymbols] = useState([]);
  const [form, setForm] = useState({ symbol: 'BTCUSDT', side: 'LONG', marginUSDT: 100, leverage: 10, tpRoiPct: 5, slRoiPct: 5 });
  const [state, setState] = useState({ position: null, orders: [] });
  const [lastAction, setLastAction] = useState(null);

  useEffect(() => { fetch(`${API_BASE}/api/universe/list`).then((r) => r.json()).then((d) => setSymbols(d.symbols || [])).catch(() => {}); }, []);
  const refresh = async () => { const out = await ws.request('manual.getDemoState', { symbol: form.symbol }); if (out?.ok) setState(out); };
  useEffect(() => { refresh(); }, [form.symbol]);

  const preview = useMemo(() => {
    const px = Number(state.position?.markPrice || state.position?.avgPrice || 0);
    const qty = px > 0 ? (Number(form.marginUSDT) * Number(form.leverage)) / px : 0;
    return { px, qty, notional: qty * px };
  }, [form, state.position]);

  return <Row className='g-3'>
    <Col md={6}><Card><Card.Body><Card.Title>Manual DEMO order</Card.Title>
      <Form.Select className='mb-2' value={form.symbol} onChange={(e) => setForm((p) => ({ ...p, symbol: e.target.value }))}>{symbols.map((s) => <option key={s}>{s}</option>)}</Form.Select>
      <Form.Select className='mb-2' value={form.side} onChange={(e) => setForm((p) => ({ ...p, side: e.target.value }))}><option>LONG</option><option>SHORT</option></Form.Select>
      {['marginUSDT','leverage','tpRoiPct','slRoiPct'].map((k) => <Form.Control key={k} className='mb-2' type='number' value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: Number(e.target.value) }))} />)}
      <div className='mb-2 text-muted'>MARK: {preview.px || '-'} | qty: {preview.qty.toFixed(4)} | notional: {preview.notional.toFixed(2)}</div>
      <Button onClick={async () => { const out = await ws.request('manual.placeDemoOrder', form); setLastAction(out); refresh(); }}>Разместить ордер</Button>
    </Card.Body></Card></Col>
    <Col md={6}><Card><Card.Body><Card.Title>Manage / Close</Card.Title>
      <div className='d-flex gap-2 mb-2'><Button variant='warning' onClick={async () => { const out = await ws.request('manual.closeDemoPosition', { symbol: form.symbol }); setLastAction(out); refresh(); }}>Закрыть позицию (Market)</Button><Button variant='outline-danger' onClick={async () => { const out = await ws.request('manual.cancelDemoOrders', { symbol: form.symbol }); setLastAction(out); refresh(); }}>Cancel all orders (symbol)</Button></div>
      <Table size='sm'><thead><tr><th>Type</th><th>Data</th></tr></thead><tbody><tr><td>Position</td><td><pre className='mb-0'>{JSON.stringify(state.position, null, 2)}</pre></td></tr><tr><td>Open orders</td><td><pre className='mb-0'>{JSON.stringify(state.orders, null, 2)}</pre></td></tr></tbody></Table>
      <div>Status: <pre className='mb-0'>{JSON.stringify(lastAction, null, 2)}</pre></div>
    </Card.Body></Card></Col>
  </Row>;
}

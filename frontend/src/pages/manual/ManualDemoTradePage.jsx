import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const MANUAL_DEMO_MAX_NOTIONAL_USDT = Number(import.meta.env.VITE_MANUAL_DEMO_MAX_NOTIONAL_USDT || 5000);

export default function ManualDemoTradePage() {
  const ws = useWs();
  const [symbols, setSymbols] = useState([]);
  const [form, setForm] = useState({ symbol: 'BTCUSDT', side: 'LONG', marginUSDT: 100, leverage: 10, tpRoiPct: 5, slRoiPct: 5 });
  const [state, setState] = useState({ position: null, orders: [], quote: null });
  const [lastAction, setLastAction] = useState(null);

  const refresh = useCallback(async (symbol) => {
    const [out, quote] = await Promise.all([
      ws.request('manual.getDemoState', { symbol }),
      ws.request('manual.getQuote', { symbol }),
    ]);
    if (out?.ok) setState({ position: out.position, orders: out.orders, quote });
  }, [ws]);

  useEffect(() => { fetch(`${API_BASE}/api/universe/list`).then((r) => r.json()).then((d) => setSymbols(d.symbols || [])).catch(() => {}); }, []);

  const preview = useMemo(() => {
    const px = Number(state.quote?.markPrice || state.quote?.lastPrice || state.position?.markPrice || state.position?.avgPrice || 0);
    const qty = px > 0 ? (Number(form.marginUSDT) * Number(form.leverage)) / px : 0;
    return { px, qty, notional: qty * px };
  }, [form, state.position, state.quote]);

  const canSubmit = Boolean(form.symbol) && preview.px > 0
    && Number(form.marginUSDT) > 0 && Number(form.leverage) > 0
    && Number.isFinite(Number(form.tpRoiPct)) && Number.isFinite(Number(form.slRoiPct));

  return <Row className='g-3'>
    <Col md={6}><Card><Card.Body><Card.Title>Manual DEMO order</Card.Title>
      <Form.Group className='mb-2'>
        <Form.Label>Symbol</Form.Label>
        <Form.Select value={form.symbol} onChange={(e) => { const next = e.target.value; setForm((p) => ({ ...p, symbol: next })); refresh(next); }}>{symbols.map((s) => <option key={s}>{s}</option>)}</Form.Select>
        <Form.Text className='text-muted'>Торговый инструмент Bybit linear (например BTCUSDT).</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>Side</Form.Label>
        <Form.Select value={form.side} onChange={(e) => setForm((p) => ({ ...p, side: e.target.value }))}><option>LONG</option><option>SHORT</option></Form.Select>
        <Form.Text className='text-muted'>LONG открывает Buy-позицию, SHORT — Sell.</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>Margin (USDT)</Form.Label>
        <Form.Control type='number' value={form.marginUSDT} onChange={(e) => setForm((p) => ({ ...p, marginUSDT: Number(e.target.value) }))} />
        <Form.Text className='text-muted'>Сумма маржи. Qty считается автоматически из margin × leverage / markPrice.</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>Leverage</Form.Label>
        <Form.Control type='number' value={form.leverage} onChange={(e) => setForm((p) => ({ ...p, leverage: Number(e.target.value) }))} />
        <Form.Text className='text-muted'>Плечо для расчёта позиции и TP/SL ROI.</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>TP ROI (%)</Form.Label>
        <Form.Control type='number' value={form.tpRoiPct} onChange={(e) => setForm((p) => ({ ...p, tpRoiPct: Number(e.target.value) }))} />
        <Form.Text className='text-muted'>Целевой ROI, который переводится в take-profit цену.</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>SL ROI (%)</Form.Label>
        <Form.Control type='number' value={form.slRoiPct} onChange={(e) => setForm((p) => ({ ...p, slRoiPct: Number(e.target.value) }))} />
        <Form.Text className='text-muted'>Допустимый убыток в ROI, переводится в stop-loss цену.</Form.Text>
      </Form.Group>
      <div className='mb-2 text-muted'>MARK/LAST: {preview.px || '-'} | qty: {preview.qty.toFixed(4)} | notional: {preview.notional.toFixed(2)} | limit: {MANUAL_DEMO_MAX_NOTIONAL_USDT}</div>
      <Button disabled={!canSubmit} onClick={async () => { const out = await ws.request('manual.placeDemoOrder', form); setLastAction(out); refresh(form.symbol); }}>Разместить ордер</Button>
    </Card.Body></Card></Col>
    <Col md={6}><Card><Card.Body><Card.Title>Manage / Close</Card.Title>
      <div className='d-flex gap-2 mb-2'><Button variant='warning' onClick={async () => { const out = await ws.request('manual.closeDemoPosition', { symbol: form.symbol }); setLastAction(out); refresh(form.symbol); }}>Закрыть позицию (Market)</Button><Button variant='outline-danger' onClick={async () => { const out = await ws.request('manual.cancelDemoOrders', { symbol: form.symbol }); setLastAction(out); refresh(form.symbol); }}>Cancel all orders (symbol)</Button></div>
      <Table size='sm'><thead><tr><th>Type</th><th>Data</th></tr></thead><tbody><tr><td>Quote</td><td><pre className='mb-0'>{JSON.stringify(state.quote, null, 2)}</pre></td></tr><tr><td>Position</td><td><pre className='mb-0'>{JSON.stringify(state.position, null, 2)}</pre></td></tr><tr><td>Open orders</td><td><pre className='mb-0'>{JSON.stringify(state.orders, null, 2)}</pre></td></tr></tbody></Table>
      <div>Status: <pre className='mb-0'>{JSON.stringify(lastAction, null, 2)}</pre></div>
    </Card.Body></Card></Col>
  </Row>;
}

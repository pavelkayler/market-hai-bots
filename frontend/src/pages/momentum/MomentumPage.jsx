import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';
import { DEFAULT_MOMENTUM_FORM } from './defaults.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

const FIELD_META = {
  mode: { label: 'Execution mode', text: 'paper — локальная симуляция, demo — торговля на Bybit DEMO через private REST.' },
  directionMode: { label: 'Direction', text: 'BOTH проверяет LONG и SHORT; LONG/SHORT ограничивает сигналы только одной стороной.' },
  windowMinutes: { label: 'W (minutes)', text: 'Размер окна для расчёта price/OI change относительно предыдущей свечи этого интервала.' },
  turnover24hMin: { label: 'Min 24h turnover (USDT)', text: 'Фильтр ликвидности: символы с turnover24h ниже порога не участвуют в скане.' },
  vol24hMin: { label: 'Min 24h volatility (%)', text: 'Минимальная 24h волатильность для отбора активных символов во входной universe.' },
  priceThresholdPct: { label: 'Price change over W (%)', text: 'Порог изменения цены за окно W. LONG: >= порог, SHORT: <= -порог.' },
  oiThresholdPct: { label: 'OI value change over W (%)', text: 'Порог изменения OI value за окно W. LONG: рост, SHORT: падение на величину порога.' },
  turnoverSpikePct: { label: 'Turnover spike (%)', text: 'Доп. фильтр для LONG: текущий turnover свечи должен быть >= baseline × (1 + spike/100). 0 = выключено.' },
  baselineFloorUSDT: { label: 'Turnover baseline floor (USDT)', text: 'Минимальная база turnover для spike-фильтра; если baseline ниже, сигнал LONG не рассматривается.' },
  holdSeconds: { label: 'Conditions must hold (ticks)', text: 'Сколько последовательных тиков все условия должны держаться перед созданием trigger.' },
  trendConfirmSeconds: { label: 'Trend confirm (seconds)', text: 'Подтверждение тренда по истории цены: используется в getTrendOk(symbol, seconds, side).' },
  oiMaxAgeSec: { label: 'Max OI staleness (sec)', text: 'Максимальный возраст OI. Если OI старше — символ временно пропускается как stale.' },
  entryOffsetPct: { label: 'Entry offset (%)', text: 'Смещение trigger цены: trigger = sourcePrice × (1 + offset/100), знак сохраняется (например -0.01%).' },
  marginUsd: { label: 'Margin (USDT)', text: 'Маржа на вход; фактический qty рассчитывается из margin × leverage / entryPrice.' },
  leverage: { label: 'Leverage', text: 'Кредитное плечо для входа и расчёта TP/SL ROI.' },
  tpRoiPct: { label: 'TP ROI (%)', text: 'Целевой ROI для take-profit. Конвертируется в TP цену через calcTpSl().' },
  slRoiPct: { label: 'SL ROI (%)', text: 'Риск-лимит ROI для stop-loss. Конвертируется в SL цену через calcTpSl().' },
};

export default function MomentumPage() {
  const ws = useWs();
  const [form, setForm] = useState(DEFAULT_MOMENTUM_FORM);
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [trades, setTrades] = useState([]);
  const [fixedSignals, setFixedSignals] = useState([]);
  const [sort, setSort] = useState({ key: 'entryTs', dir: 'desc' });
  const [universe, setUniverse] = useState([]);

  useEffect(() => { fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()).then((r) => setUniverse(r?.outputs?.tiers || [])).catch(() => {}); }, []);

  useEffect(() => {
    const loop = setInterval(async () => {
      const list = await ws.request('momentum.list', {});
      if (list?.ok) {
        setInstances(list.instances || []);
        setSelectedId((prev) => prev || list.instances?.[0]?.id || '');
      }
      if (!selectedId) return;
      const state = await ws.request('momentum.getState', { instanceId: selectedId });
      if (state?.ok) setDetail(state.stateSnapshot);
      const t = await ws.request('momentum.getTrades', { instanceId: selectedId, limit: 300, offset: 0 });
      if (t?.ok) setTrades(t.trades || []);
      const fs = await ws.request('momentum.getFixedSignals', { instanceId: selectedId, limit: 200 });
      if (fs?.ok) setFixedSignals(fs.rows || []);
    }, 1200);
    return () => clearInterval(loop);
  }, [ws, selectedId]);

  const onStart = async () => { const out = await ws.request('momentum.start', { config: form }); if (out?.ok) setSelectedId(out.instanceId); };
  const onStop = async (id) => { await ws.request('momentum.stop', { instanceId: id }); };
  const onContinue = async (id) => { await ws.request('momentum.continue', { instanceId: id }); };

  const sortedTrades = useMemo(() => {
    const rows = [...trades];
    rows.sort((a, b) => {
      const av = a?.[sort.key]; const bv = b?.[sort.key];
      const cmp = (Number.isFinite(Number(av)) && Number.isFinite(Number(bv))) ? (Number(av) - Number(bv)) : String(av ?? '').localeCompare(String(bv ?? ''));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [trades, sort]);

  const latestSignals = useMemo(() => {
    const rows = Array.isArray(detail?.signalNotifications) ? [...detail.signalNotifications] : [];
    rows.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const bySymbol = new Map();
    for (const row of rows) {
      const symbol = String(row?.symbol || 'UNKNOWN');
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, row);
    }
    return [...bySymbol.values()].sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0)).slice(0, 5);
  }, [detail]);

  const stats = useMemo(() => {
    const total = trades.length; const longs = trades.filter((t) => t.side === 'LONG'); const shorts = trades.filter((t) => t.side === 'SHORT');
    const isWin = (t) => Number(t.pnlNet ?? t.realizedPnl ?? t.pnlUsd ?? 0) > 0;
    return { total, longCount: longs.length, shortCount: shorts.length, longWin: longs.filter(isWin).length, shortWin: shorts.filter(isWin).length };
  }, [trades]);

  const tierSet = new Set(form.tierIndices || []);

  const renderField = (key) => <Form.Group key={key} className='mb-2'>
    <Form.Label>{FIELD_META[key].label}</Form.Label>
    <Form.Control type='number' value={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: Number(e.target.value) }))} />
    <Form.Text className='text-muted'>{FIELD_META[key].text}</Form.Text>
  </Form.Group>;

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body>
      <Card.Title>Momentum</Card.Title>
      <Form.Group className='mb-2'>
        <Form.Label>{FIELD_META.mode.label}</Form.Label>
        <Form.Select value={form.mode} onChange={(e) => setForm((p) => ({ ...p, mode: e.target.value }))}><option value='paper'>paper</option><option value='demo'>demo</option></Form.Select>
        <Form.Text className='text-muted'>{FIELD_META.mode.text}</Form.Text>
      </Form.Group>
      <Form.Group className='mb-2'>
        <Form.Label>{FIELD_META.directionMode.label}</Form.Label>
        <Form.Select value={form.directionMode} onChange={(e) => setForm((p) => ({ ...p, directionMode: e.target.value }))}><option>BOTH</option><option>LONG</option><option>SHORT</option></Form.Select>
        <Form.Text className='text-muted'>{FIELD_META.directionMode.text}</Form.Text>
      </Form.Group>
      {['windowMinutes', 'turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct'].map(renderField)}
      <div className='mb-2'>
        <Button size='sm' variant='outline-secondary' onClick={() => setForm((p) => ({ ...p, tierIndices: universe.map((t) => Number(t.tierIndex)) }))}>Выбрать все</Button>{' '}
        <Button size='sm' variant='outline-secondary' onClick={() => setForm((p) => ({ ...p, tierIndices: [] }))}>Снять все</Button>
      </div>
      {(universe || []).map((t) => <Form.Check key={t.tierIndex} type='checkbox' label={`Tier ${t.tierIndex} (${t.size})`} checked={tierSet.has(Number(t.tierIndex))} onChange={(e) => setForm((p) => ({ ...p, universeMode: 'TIERS', tierIndices: e.target.checked ? [...new Set([...(p.tierIndices || []), Number(t.tierIndex)])] : (p.tierIndices || []).filter((x) => Number(x) !== Number(t.tierIndex)) }))} />)}
      <div className='d-flex gap-2 mt-3'><Button onClick={onStart}>Create</Button><Button variant='outline-secondary' onClick={() => setForm(DEFAULT_MOMENTUM_FORM)}>Reset</Button></div>
    </Card.Body></Card></Col>

    <Col md={8}><Card><Card.Body>
      <Card.Title>Bots summary</Card.Title>
      <Table size='sm' style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}><thead><tr><th>ID</th><th>Config</th><th>Action</th></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td><div>{i.id}</div><div><Badge bg={i.status === 'RUNNING' ? 'success' : 'secondary'}>{i.status}</Badge></div></td><td><div>{i.singleSymbol || `tiers: ${(i.tierIndices || []).join(',')}`}</div><div className='text-muted'>W={i.windowMinutes}, mode={i.mode}, margin={i.marginUsd}, lev={i.leverage}</div></td><td>{i.status === 'RUNNING' ? <Button size='sm' variant='danger' onClick={() => onStop(i.id)}>Stop</Button> : <Button size='sm' onClick={() => onContinue(i.id)}>Continue</Button>}</td></tr>)}
      </tbody></Table>

      <Form.Select className='mb-2' value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value=''>Select</option>{instances.map((i) => <option key={i.id} value={i.id}>{i.id}</option>)}</Form.Select>
      <div className='mb-2'>Active trades / Pending trades: {detail?.openPositions?.length || 0} / {detail?.pendingOrders?.length || 0}</div>

      <h6>Зафиксированные сигналы</h6>
      <Table size='sm'><thead><tr><th>time</th><th>symbol</th><th>side</th><th>W</th><th>priceΔ%</th><th>oiΔ%</th><th>action</th><th>reason</th></tr></thead><tbody>
        {fixedSignals.map((r) => <tr key={r.id}><td>{new Date(r.tsMs).toLocaleTimeString()}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.windowMinutes}</td><td style={{ fontFamily: 'monospace' }}>{Number(r.metrics?.priceChangePctW || 0).toFixed(2)}</td><td style={{ fontFamily: 'monospace' }}>{Number(r.metrics?.oiChangePctW || 0).toFixed(2)}</td><td>{r.action}</td><td>{r.reason || '-'}</td></tr>)}
      </tbody></Table>

      <h6>Trades ({stats.total})</h6>
      <div className='text-muted mb-1'>Long: {stats.longCount} ({stats.total ? ((stats.longCount * 100) / stats.total).toFixed(1) : 0}%) | Short: {stats.shortCount} ({stats.total ? ((stats.shortCount * 100) / stats.total).toFixed(1) : 0}%) | Long win%: {stats.longCount ? ((stats.longWin * 100) / stats.longCount).toFixed(1) : 0}% | Short win%: {stats.shortCount ? ((stats.shortWin * 100) / stats.shortCount).toFixed(1) : 0}%</div>
      <div style={{ height: 340, overflow: 'auto', resize: 'vertical', minHeight: 220, maxHeight: '70vh' }}>
        <Table size='sm'><thead><tr>{['symbol', 'side', 'entryTs', 'entryPrice', 'exitPrice', 'qty', 'pnlNet', 'outcome'].map((k) => <th key={k} onClick={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }))} style={{ cursor: 'pointer' }}>{k} {sort.key === k ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</th>)}</tr></thead><tbody>{sortedTrades.map((t) => <tr key={t.id}><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryTs}</td><td>{t.entryPriceActual || t.entryPrice}</td><td>{t.exitPrice}</td><td>{t.qty}</td><td>{Number(t.pnlNet ?? t.pnlUsd ?? 0).toFixed(3)}</td><td>{t.outcome}</td></tr>)}</tbody></Table>
      </div>

      <h6>Signals</h6>
      <Table size='sm'><tbody>{latestSignals.map((n, idx) => <tr key={`${n.symbol}-${n.ts || idx}`}><td>{n.symbol}</td><td>{n.action}</td><td>{n.message}</td></tr>)}</tbody></Table>
    </Card.Body></Card></Col>
  </Row>;
}

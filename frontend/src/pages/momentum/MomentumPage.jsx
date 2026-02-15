import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';
import { DEFAULT_MOMENTUM_FORM } from './defaults.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const DRAFT_KEY = 'momentumDraftConfig';
const NUMERIC_FIELDS = ['windowMinutes', 'turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct'];

const toFormStrings = (cfg = {}) => ({ ...DEFAULT_MOMENTUM_FORM, ...cfg, ...Object.fromEntries(NUMERIC_FIELDS.map((key) => [key, String(cfg?.[key] ?? DEFAULT_MOMENTUM_FORM[key] ?? '')])) });
const normalizeForm = (form) => {
  const out = { ...form };
  for (const key of NUMERIC_FIELDS) {
    const raw = String(form?.[key] ?? '').trim();
    const fallback = Number(DEFAULT_MOMENTUM_FORM[key] || 0);
    if (raw === '') out[key] = fallback;
    else {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? n : fallback;
    }
  }
  return out;
};

export default function MomentumPage() {
  const ws = useWs();
  const [form, setForm] = useState(() => toFormStrings(JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') || DEFAULT_MOMENTUM_FORM));
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [trades, setTrades] = useState([]);
  const [fixedSignals, setFixedSignals] = useState([]);
  const [latestSignals, setLatestSignals] = useState([]);
  const [statsView, setStatsView] = useState(null);
  const [universeSymbols, setUniverseSymbols] = useState([]);
  const [inspectSymbol, setInspectSymbol] = useState('');
  const [inspectData, setInspectData] = useState(null);
  const statsRef = useRef(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()).then((r) => {
      const symbols = (r?.outputs?.tiers || []).flatMap((t) => t.symbols || []);
      setUniverseSymbols(symbols);
      if (!inspectSymbol && symbols[0]) setInspectSymbol(symbols[0]);
    }).catch(() => {});
  }, [inspectSymbol]);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    const [state, t, fs] = await Promise.all([
      ws.request('momentum.getInstanceState', { instanceId: id }),
      ws.request('momentum.getTrades', { instanceId: id, limit: 300, offset: 0 }),
      ws.request('momentum.getFixedSignals', { instanceId: id, limit: 100 }),
    ]);
    if (state?.ok) {
      setDetail(state.stateSnapshot);
      const rows = (state.stateSnapshot?.signalNotifications || []).slice(0, 100);
      setLatestSignals((prev) => rows.reduce((acc, row) => {
        const top = acc[0];
        if (top && top.symbol === row.symbol && top.action === row.action && top.message === row.message) {
          acc[0] = { ...top, ts: row.ts, count: Number(top.count || 1) + 1 };
          return acc;
        }
        return [{ ...row, count: 1 }, ...acc].slice(0, 3);
      }, prev.slice(0, 3)));
    }
    if (t?.ok) setTrades(t.trades || []);
    if (fs?.ok) setFixedSignals(fs.rows || []);
  }, [ws]);

  useEffect(() => {
    const loop = setInterval(async () => {
      const list = await ws.request('momentum.list', {});
      if (list?.ok) {
        setInstances(list.instances || []);
        if (!selectedId && list.instances?.[0]?.id) setSelectedId(list.instances[0].id);
      }
      if (document.visibilityState === 'visible' && selectedId) await loadSelected(selectedId);
    }, 1500);
    return () => clearInterval(loop);
  }, [ws, selectedId, loadSelected]);

  useEffect(() => { if (selectedId) loadSelected(selectedId); }, [selectedId, loadSelected]);

  const setField = (key, value) => setForm((p) => ({ ...p, [key]: value }));
  const save = async () => {
    const normalized = normalizeForm(form);
    if (selectedId) await ws.request('momentum.updateInstanceConfig', { instanceId: selectedId, patch: normalized });
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(normalized));
  };

  const onStart = async () => {
    const out = await ws.request('momentum.start', { config: normalizeForm(form) });
    if (out?.ok) setSelectedId(out.instanceId);
  };

  const loadStats = async (botId) => {
    setSelectedId(botId);
    const res = await fetch(`${API_BASE}/api/momentum/bots/${botId}/stats`).then((r) => r.json());
    setStatsView(res);
    setTimeout(() => statsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const refreshInspect = async () => {
    if (!inspectSymbol) return;
    const q = new URLSearchParams({ symbol: inspectSymbol, botId: selectedId || '' });
    const out = await fetch(`${API_BASE}/api/momentum/inspect?${q}`).then((r) => r.json());
    setInspectData(out);
  };

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body>
      <Card.Title>Momentum Settings</Card.Title>
      {NUMERIC_FIELDS.map((key) => <Form.Group key={key} className='mb-2'><Form.Label>{key}</Form.Label><Form.Control value={form[key]} onChange={(e) => setField(key, e.target.value)} onBlur={save} /></Form.Group>)}
      <Button onClick={onStart}>Create</Button>
      <Card className='mt-3'><Card.Body>
        <div className='d-flex justify-content-between align-items-center'><strong>Signals</strong><Badge bg='secondary'>max 3</Badge></div>
        <Table size='sm'><tbody>{latestSignals.map((n, idx) => <tr key={`${n.symbol}-${n.action}-${idx}`}><td>{n.symbol}</td><td>{n.action}</td><td>{n.count > 1 ? `x${n.count}` : ''} {n.message}</td></tr>)}</tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      <Card.Title>Bots summary</Card.Title>
      <Table size='sm'><thead><tr><th>ID</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id}</td><td><Badge bg={i.status === 'RUNNING' ? 'success' : 'secondary'}>{i.status}</Badge></td><td className='d-flex gap-1'><Button size='sm' onClick={() => loadStats(i.id)}>View stats</Button><Button size='sm' variant='outline-danger' onClick={() => ws.request('momentum.deleteInstance', { instanceId: i.id })}>Delete</Button></td></tr>)}
      </tbody></Table>

      <h6>Зафиксированные сигналы</h6>
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <Table size='sm'><thead style={{ position: 'sticky', top: 0, background: 'white' }}><tr><th>time</th><th>symbol</th><th>side</th><th>action</th><th>reason</th></tr></thead><tbody>
          {fixedSignals.slice(0, 200).map((r) => <tr key={r.id}><td>{new Date(r.tsMs).toLocaleTimeString()}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.action}</td><td>{r.reason || '-'}</td></tr>)}
        </tbody></Table>
      </div>

      <h6 ref={statsRef}>Runs</h6>
      <Table size='sm'><thead><tr><th>runId</th><th>startedAt</th><th>stoppedAt</th><th>mode</th><th>trades</th><th>winrate</th><th>pnl</th></tr></thead><tbody>
        {(statsView?.runs || []).map((r) => <tr key={r.runId}><td>{r.runId}</td><td>{new Date(r.startedAt).toLocaleString()}</td><td>{r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : '-'}</td><td>{r.mode}</td><td>{r.tradesCount}</td><td>{Number(r.winrate || 0).toFixed(1)}%</td><td>{Number(r.pnl || 0).toFixed(3)}</td></tr>)}
      </tbody></Table>
      <h6>Trades</h6>
      <Table size='sm'><thead><tr><th>runId</th><th>symbol</th><th>side</th><th>entry</th><th>exit</th><th>qty</th><th>pnl</th><th>outcome</th></tr></thead><tbody>
        {(statsView?.trades || []).map((t) => <tr key={t.id}><td>{t.runId || '-'}</td><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryPriceActual || t.entryPrice}</td><td>{t.exitPrice}</td><td>{t.entryQtyActual || t.qty}</td><td>{Number(t.pnlNet ?? t.pnlUsd ?? 0).toFixed(3)}</td><td>{t.outcome}</td></tr>)}
      </tbody></Table>

      <Card className='mt-3'><Card.Body>
        <Card.Title>Запрос данных / Инспектор метрик</Card.Title>
        <div className='d-flex gap-2 mb-2'><Form.Select value={inspectSymbol} onChange={(e) => setInspectSymbol(e.target.value)}>{universeSymbols.map((s) => <option key={s}>{s}</option>)}</Form.Select><Button onClick={refreshInspect}>Refresh</Button></div>
        <Table size='sm'><thead><tr><th>Metric</th><th>Current</th><th>Threshold</th><th>PASS/FAIL</th><th>source</th></tr></thead><tbody>
          {Object.entries(inspectData?.metrics || {}).map(([key, v]) => <tr key={key}><td>{key}</td><td>{v.human}</td><td>{inspectData?.thresholds?.[key] ? `${inspectData.thresholds[key].op} ${inspectData.thresholds[key].value}` : '-'}</td><td>{inspectData?.checks?.[key]?.pass ? 'PASS' : 'FAIL'} {inspectData?.checks?.[key]?.reason || ''}</td><td>{inspectData?.source} / {inspectData?.tsMs}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>
  </Row>;
}

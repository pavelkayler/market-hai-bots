import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';
import { DEFAULT_MOMENTUM_FORM } from './defaults.js';
import { MOMENTUM_FIELD_META } from './fieldMeta.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const DRAFT_KEY = 'momentumDraftConfig';
const NUMERIC_FIELDS = ['turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct', 'cooldownMinutes', 'maxNewEntriesPerTick'];
const FIELD_ORDER = ['mode', 'directionMode', 'windowMinutes', ...NUMERIC_FIELDS, 'entryPriceSource', 'globalSymbolLock'];
const normalizeTierIndices = (arr) => [...new Set((arr || []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0 && n <= 6))].sort((a, b) => a - b);

const toFormStrings = (cfg = {}) => {
  const base = { ...DEFAULT_MOMENTUM_FORM, ...cfg };
  const out = { ...base, tierIndices: normalizeTierIndices(base.tierIndices) };
  for (const key of NUMERIC_FIELDS) out[key] = String(base[key] ?? '');
  return out;
};

export default function MomentumPage() {
  const ws = useWs();
  const [form, setForm] = useState(() => toFormStrings(JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') || DEFAULT_MOMENTUM_FORM));
  const [instances, setInstances] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [fixedSignals, setFixedSignals] = useState([]);
  const [latestSignals, setLatestSignals] = useState([]);
  const [statsView, setStatsView] = useState(null);
  const [statsError, setStatsError] = useState('');
  const [statusText, setStatusText] = useState('Saved');
  const [universeSymbols, setUniverseSymbols] = useState([]);
  const [inspectSymbol, setInspectSymbol] = useState('');
  const [inspectData, setInspectData] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const debounceRef = useRef(new Map());

  const saveDraft = useCallback((next) => localStorage.setItem(DRAFT_KEY, JSON.stringify(next)), []);

  const persistPatch = useCallback(async (patch = {}) => {
    if (!Object.keys(patch).length) return;
    if (selectedId) {
      const out = await ws.request('momentum.updateInstanceConfig', { instanceId: selectedId, patch });
      if (!out?.ok) throw new Error(out?.message || out?.error || 'update config failed');
      return;
    }
    saveDraft({ ...DEFAULT_MOMENTUM_FORM, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'), ...patch });
  }, [selectedId, ws, saveDraft]);

  const loadUniverse = useCallback(async () => {
    const result = await fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()).catch(() => ({}));
    const symbols = [...new Set((result?.outputs?.tiers || []).flatMap((t) => t?.symbols || []))].sort((a, b) => a.localeCompare(b));
    setUniverseSymbols(symbols);
    if (!inspectSymbol && symbols[0]) setInspectSymbol(symbols[0]);
  }, [inspectSymbol]);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    const [state, fs, ls] = await Promise.all([
      ws.request('momentum.getInstanceState', { instanceId: id }),
      ws.request('momentum.getFixedSignals', { instanceId: id, limit: 10 }),
      ws.request('momentum.getSignals', { instanceId: id, limit: 3 }),
    ]);
    if (state?.ok) setForm(toFormStrings(state.stateSnapshot?.config || {}));
    if (fs?.ok) setFixedSignals([...(fs.rows || [])].sort((a, b) => Number(b.tsMs || 0) - Number(a.tsMs || 0)).slice(0, 10));
    if (ls?.ok) setLatestSignals([...(ls.rows || [])].sort((a, b) => Number(b.tsMs || 0) - Number(a.tsMs || 0)).slice(0, 3));
  }, [ws]);

  useEffect(() => { loadUniverse(); }, [loadUniverse]);
  useEffect(() => {
    const loop = setInterval(async () => {
      const list = await ws.request('momentum.list', {});
      if (list?.ok) {
        setInstances(list.instances || []);
        if (!selectedId && list.instances?.[0]?.id) setSelectedId(list.instances[0].id);
      }
      if (selectedId) await loadSelected(selectedId);
    }, 1500);
    return () => clearInterval(loop);
  }, [ws, selectedId, loadSelected]);
  useEffect(() => { if (selectedId) loadSelected(selectedId); }, [selectedId, loadSelected]);

  const setField = (key, value) => { setStatusText('Unsaved'); setForm((prev) => ({ ...prev, [key]: value })); };

  const savePatch = async (patch) => {
    try {
      await persistPatch(patch);
      setStatusText('Saved');
    } catch (e) {
      setStatusText(`Unsaved: ${String(e.message || e)}`);
    }
  };

  const onNumericChange = (key, raw) => {
    setField(key, raw);
    const old = debounceRef.current.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      const n = Number(String(raw).trim());
      if (Number.isFinite(n)) savePatch({ [key]: n });
    }, 500);
    debounceRef.current.set(key, timer);
  };

  const onStart = async () => {
    const payload = { ...DEFAULT_MOMENTUM_FORM, ...form, tierIndices: normalizeTierIndices(form.tierIndices), windowMinutes: Number(form.windowMinutes) };
    for (const key of NUMERIC_FIELDS) {
      const n = Number(String(form[key] || '').trim());
      if (!Number.isFinite(n)) return alert(`Invalid numeric value: ${key}`);
      payload[key] = n;
    }
    if (![1, 3, 5].includes(payload.windowMinutes)) return alert('windowMinutes must be 1/3/5');
    if (!payload.tierIndices.length) payload.tierIndices = [1, 2, 3, 4, 5, 6];

    const out = await ws.request('momentum.start', { config: payload });
    if (!out?.ok) return alert(out?.message || out?.error || 'create failed');
    setSelectedId(out.instanceId);
    await loadSelected(out.instanceId);
  };

  const loadStats = async (id) => {
    setStatsError('');
    try {
      setSelectedId(id);
      const res = await fetch(`${API_BASE}/api/momentum/bots/${encodeURIComponent(id)}/stats`).then((r) => r.json());
      setStatsView(res);
    } catch (e) {
      const msg = String(e?.message || e || 'unknown error');
      setStatsError(msg);
      alert(`View stats failed: ${msg}`);
    }
  };

  const refreshInspect = async () => {
    if (!inspectSymbol) return;
    const q = new URLSearchParams({ symbol: inspectSymbol });
    if (selectedId) q.set('botId', selectedId);
    const out = await fetch(`${API_BASE}/api/momentum/inspect?${q.toString()}`).then((r) => r.json());
    if (!out?.ok) {
      setInspectError(out?.error || 'inspect failed');
      return;
    }
    setInspectError('');
    setInspectData(out);
  };

  const toggleTier = (idx) => {
    const next = new Set(form.tierIndices || []);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    const tierIndices = normalizeTierIndices([...next]);
    setField('tierIndices', tierIndices);
    savePatch({ tierIndices: tierIndices.length ? tierIndices : [] });
  };

  const metricKeys = useMemo(() => Object.keys(inspectData?.metrics || {}), [inspectData]);

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body>
      <Card.Title>Momentum settings <Badge bg={statusText.startsWith('Saved') ? 'success' : 'warning'}>{statusText}</Badge></Card.Title>
      {FIELD_ORDER.map((key) => {
        const meta = MOMENTUM_FIELD_META[key];
        if (!meta) return null;
        if (key === 'globalSymbolLock') return <Form.Group key={key} className='mb-2'><Form.Check type='switch' label={meta.label} checked={Boolean(form[key])} onChange={(e) => { setField(key, e.target.checked); savePatch({ [key]: e.target.checked }); }} /><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        if (key === 'windowMinutes') return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}</Form.Label><Form.Select value={form.windowMinutes} onChange={(e) => { setField('windowMinutes', Number(e.target.value)); savePatch({ windowMinutes: Number(e.target.value) }); }}><option value={1}>1</option><option value={3}>3</option><option value={5}>5</option></Form.Select><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        if (key === 'mode' || key === 'directionMode' || key === 'entryPriceSource') {
          const options = key === 'mode' ? ['paper', 'demo', 'real'] : (key === 'directionMode' ? ['LONG', 'SHORT', 'BOTH'] : ['MARK', 'LAST']);
          return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}</Form.Label><Form.Select value={form[key]} onChange={(e) => { setField(key, e.target.value); savePatch({ [key]: e.target.value }); }}>{options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</Form.Select><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        }
        return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}</Form.Label><Form.Control value={form[key]} onChange={(e) => onNumericChange(key, e.target.value)} /><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
      })}

      <Card className='mb-2'><Card.Body>
        <div className='d-flex gap-2 align-items-center mb-2'><strong>Tiers</strong><Button size='sm' variant='outline-secondary' onClick={() => { setField('tierIndices', [1, 2, 3, 4, 5, 6]); savePatch({ tierIndices: [1, 2, 3, 4, 5, 6] }); }}>Select all</Button><Button size='sm' variant='outline-secondary' onClick={() => { setField('tierIndices', []); savePatch({ tierIndices: [] }); }}>Clear all</Button></div>
        {[1, 2, 3, 4, 5, 6].map((idx) => <Form.Check key={idx} type='checkbox' label={`tier ${idx}`} checked={(form.tierIndices || []).includes(idx)} onChange={() => toggleTier(idx)} />)}
      </Card.Body></Card>

      <Button onClick={onStart}>Create</Button>
      <Card className='mt-3'><Card.Body>
        <div className='d-flex justify-content-between align-items-center'><strong>Signals</strong><Badge bg='secondary'>3 latest</Badge></div>
        <Table size='sm'><tbody>{latestSignals.map((n, idx) => <tr key={`${n.symbol}-${n.action}-${idx}`}><td>{n.symbol}</td><td>{n.action}</td><td>{n.message}</td></tr>)}</tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>

    <Col md={8}><Card><Card.Body>
      <Card.Title>Bots summary</Card.Title>
      <Table size='sm'><thead><tr><th>ID</th><th>Status</th><th>Config</th><th>Action</th></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id}</td><td><Badge bg={i.status === 'RUNNING' ? 'success' : 'secondary'}>{i.status}</Badge></td><td>mode={i.mode} | trades={i.tradesCount || 0} | winrate={Number(i.winratePct || 0).toFixed(1)}% | pnl={Number(i.pnl || 0).toFixed(2)}</td><td className='d-flex gap-1'>
          {i.status === 'STOPPED' && <Button size='sm' variant='outline-success' onClick={async () => { const out = await ws.request('momentum.continue', { instanceId: i.id }); if (!out?.ok) alert(out?.error || 'continue failed'); }}>Continue</Button>}
          {i.status === 'RUNNING' && <Button size='sm' variant='outline-warning' onClick={async () => { const out = await ws.request('momentum.stop', { instanceId: i.id }); if (!out?.ok) alert(out?.error || 'stop failed'); }}>Stop</Button>}
          <Button size='sm' onClick={() => loadStats(i.id)}>View stats</Button>
          <Button size='sm' variant='outline-danger' onClick={async () => { await ws.request('momentum.deleteInstance', { instanceId: i.id }); }}>Delete</Button>
        </td></tr>)}
      </tbody></Table>

      <h6>Зафиксированные сигналы</h6>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        <Table size='sm'><thead style={{ position: 'sticky', top: 0, background: 'white' }}><tr><th>time</th><th>symbol</th><th>side</th><th>action</th><th>reason</th></tr></thead><tbody>
          {fixedSignals.map((r) => <tr key={r.id}><td>{new Date(r.tsMs).toLocaleTimeString()}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.action}</td><td>{r.reason || '-'}</td></tr>)}
        </tbody></Table>
      </div>

      <h6>Runs</h6>
      {statsError && <Alert variant='danger'>{statsError}</Alert>}
      <Table size='sm'><thead><tr><th>runId</th><th>startedAt</th><th>stoppedAt</th><th>mode</th><th>trades</th><th>winrate</th><th>pnl</th></tr></thead><tbody>
        {(statsView?.runs || []).map((r) => <tr key={r.runId}><td>{r.runId}</td><td>{new Date(r.startedAt).toLocaleString()}</td><td>{r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : '-'}</td><td>{r.mode}</td><td>{r.tradesCount}</td><td>{Number(r.winrate || 0).toFixed(1)}%</td><td>{Number(r.pnl || 0).toFixed(3)}</td></tr>)}
      </tbody></Table>

      <h6>Trades</h6>
      <Table size='sm'><thead><tr><th>time</th><th>runId</th><th>symbol</th><th>side</th><th>entryPrice</th><th>exitPrice</th><th>pnlUsd</th></tr></thead><tbody>
        {(statsView?.trades || []).map((t) => <tr key={t.id}><td>{t.entryTs ? new Date(t.entryTs).toLocaleString() : '-'}</td><td>{t.runId || '-'}</td><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryPriceActual || t.entryPrice || '-'}</td><td>{t.exitPrice || '-'}</td><td>{Number(t.pnlNet ?? t.pnlUsd ?? 0).toFixed(3)}</td></tr>)}
      </tbody></Table>

      <Card className='mt-3'><Card.Body>
        <Card.Title>Inspector</Card.Title>
        <div className='d-flex gap-2 mb-2'><Form.Select value={inspectSymbol} onChange={(e) => setInspectSymbol(e.target.value)}>{universeSymbols.map((s) => <option key={s}>{s}</option>)}</Form.Select><Button onClick={refreshInspect}>Refresh</Button></div>
        {inspectError && <Alert variant='danger'>{inspectError}</Alert>}
        <Table size='sm'><thead><tr><th>Metric</th><th>Current</th><th>Threshold</th><th>PASS/FAIL</th><th>Reason</th></tr></thead><tbody>
          {metricKeys.map((key) => {
            const check = inspectData?.checks?.[key];
            const status = check ? (check.pass ? 'PASS' : 'FAIL') : 'INFO';
            return <tr key={key}><td>{key}</td><td>{inspectData?.metrics?.[key]?.human || '-'}</td><td>{inspectData?.thresholds?.[key] ? `${inspectData.thresholds[key].op} ${inspectData.thresholds[key].value}` : '—'}</td><td>{status}</td><td>{check?.reason || '—'}</td></tr>;
          })}
        </tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>
  </Row>;
}

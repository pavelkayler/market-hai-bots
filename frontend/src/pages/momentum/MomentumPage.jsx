import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';
import { DEFAULT_MOMENTUM_FORM } from './defaults.js';
import { MOMENTUM_FIELD_META } from './fieldMeta.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const DRAFT_KEY = 'momentumDraftConfig';
const NUMERIC_FIELDS = ['turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct', 'cooldownMinutes', 'maxNewEntriesPerTick'];
const SETTINGS_FIELDS = ['mode', 'directionMode', 'windowMinutes', ...NUMERIC_FIELDS, 'entryPriceSource', 'globalSymbolLock'];

const normalizeTierIndices = (arr) => [...new Set((arr || []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 6))].sort((a, b) => a - b);
const toFormStrings = (cfg = {}) => {
  const merged = { ...DEFAULT_MOMENTUM_FORM, ...cfg };
  for (const k of NUMERIC_FIELDS) merged[k] = String(merged[k] ?? '');
  merged.tierIndices = normalizeTierIndices(merged.tierIndices?.length ? merged.tierIndices : DEFAULT_MOMENTUM_FORM.tierIndices);
  return merged;
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
  const [saveState, setSaveState] = useState('saved');
  const [universeSymbols, setUniverseSymbols] = useState([]);
  const [universeTiers, setUniverseTiers] = useState([]);
  const [inspectSymbol, setInspectSymbol] = useState('');
  const [inspectData, setInspectData] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const statsRef = useRef(null);

  const persistPatch = useCallback(async (patch = {}) => {
    if (!Object.keys(patch).length) return;
    setSaveState('saving');
    if (selectedId) {
      const out = await ws.request('momentum.updateInstanceConfig', { instanceId: selectedId, patch });
      if (!out?.ok) throw new Error(out?.error || out?.reason || 'updateInstanceConfig failed');
    }
    const merged = { ...DEFAULT_MOMENTUM_FORM, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'), ...patch };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(merged));
    setSaveState('saved');
  }, [selectedId, ws]);

  const loadUniverse = useCallback(async () => {
    const res = await fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()).catch(() => null);
    const tiers = res?.outputs?.tiers || [];
    const symbols = [...new Set(tiers.flatMap((t) => t.symbols || []))].sort((a, b) => a.localeCompare(b));
    setUniverseTiers(tiers);
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
      if (selectedId && document.visibilityState === 'visible') await loadSelected(selectedId);
    }, 1500);
    return () => clearInterval(loop);
  }, [ws, selectedId, loadSelected]);
  useEffect(() => { if (selectedId) loadSelected(selectedId); }, [selectedId, loadSelected]);

  const setField = (key, value) => { setForm((p) => ({ ...p, [key]: value })); setSaveState('unsaved'); };
  const onImmediateChange = async (key, value) => { setField(key, value); await persistPatch({ [key]: value }); };
  const onNumericChange = (key, raw) => setField(key, raw);
  const onNumericBlur = async (key) => {
    const n = Number(String(form[key]).trim());
    if (!Number.isFinite(n)) return;
    await persistPatch({ [key]: n });
  };

  const updateTierSelection = async (next) => {
    const normalized = normalizeTierIndices(next);
    setField('tierIndices', normalized);
    await persistPatch({ tierIndices: normalized });
  };

  const onStart = async () => {
    try {
      const payload = { ...DEFAULT_MOMENTUM_FORM, ...form, tierIndices: normalizeTierIndices(form.tierIndices) };
      if (!payload.tierIndices.length) throw new Error('Выберите хотя бы один tier.');
      for (const k of NUMERIC_FIELDS) {
        const n = Number(form[k]);
        if (!Number.isFinite(n)) throw new Error(`Невалидное число: ${k}`);
        payload[k] = n;
      }
      payload.windowMinutes = Number(form.windowMinutes);
      const out = await ws.request('momentum.start', { config: payload });
      if (!out?.ok) throw new Error(out?.message || out?.error || 'Create failed');
      setSelectedId(out.instanceId);
      await loadSelected(out.instanceId);
      alert('Momentum bot created');
    } catch (err) {
      alert(`Create error: ${String(err?.message || err)}`);
    }
  };

  const loadStats = async (botId) => {
    setStatsError('');
    setSelectedId(botId);
    try {
      const res = await fetch(`${API_BASE}/api/momentum/bots/${botId}/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatsView(await res.json());
    } catch (err) {
      const msg = String(err?.message || err);
      setStatsError(msg);
      alert(`View stats error: ${msg}`);
      setStatsView(null);
    }
    setTimeout(() => statsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  const refreshInspect = async () => {
    if (!inspectSymbol) return;
    setInspectError('');
    try {
      const q = new URLSearchParams({ symbol: inspectSymbol, botId: selectedId || '' });
      const out = await fetch(`${API_BASE}/api/momentum/inspect?${q}`).then((r) => r.json());
      setInspectData(out);
    } catch (err) {
      setInspectError(String(err?.message || err));
    }
  };

  const selectedTierCount = useMemo(() => {
    const selected = new Set(normalizeTierIndices(form.tierIndices));
    return universeTiers.filter((t) => selected.has(Number(t.tierIndex))).reduce((sum, t) => sum + (t.symbols?.length || 0), 0);
  }, [form.tierIndices, universeTiers]);

  const metricKeys = useMemo(() => [...new Set([...Object.keys(inspectData?.metrics || {}), ...Object.keys(inspectData?.checks || {})])], [inspectData]);

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body>
      <Card.Title>Momentum Settings <Badge bg={saveState === 'saved' ? 'success' : 'warning'}>{saveState}</Badge></Card.Title>
      <h6>Universe tiers</h6>
      <div className='d-flex gap-2 mb-2'>
        <Button size='sm' variant='outline-secondary' onClick={() => updateTierSelection([1, 2, 3, 4, 5, 6])}>Select all</Button>
        <Button size='sm' variant='outline-secondary' onClick={() => updateTierSelection([])}>Clear all</Button>
      </div>
      {[1, 2, 3, 4, 5, 6].map((idx) => <Form.Check key={idx} className='mb-1' type='checkbox' label={`tier ${idx}`} checked={form.tierIndices.includes(idx)} onChange={(e) => updateTierSelection(e.target.checked ? [...form.tierIndices, idx] : form.tierIndices.filter((x) => x !== idx))} />)}
      <Form.Text className='text-muted d-block mb-3'>{MOMENTUM_FIELD_META.tierIndices.help} · resolvedSymbolsCount: {selectedTierCount}</Form.Text>

      {SETTINGS_FIELDS.map((key) => {
        const meta = MOMENTUM_FIELD_META[key];
        if (key === 'globalSymbolLock') return <Form.Group key={key} className='mb-2'><Form.Check type='switch' label={meta.label} checked={Boolean(form[key])} onChange={(e) => onImmediateChange(key, e.target.checked)} /><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        if (key === 'mode' || key === 'directionMode' || key === 'entryPriceSource' || key === 'windowMinutes') {
          const options = key === 'mode' ? ['paper', 'demo', 'real'] : key === 'directionMode' ? ['LONG', 'SHORT', 'BOTH'] : key === 'entryPriceSource' ? ['MARK', 'LAST'] : [1, 3, 5];
          return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}</Form.Label><Form.Select value={form[key]} onChange={(e) => onImmediateChange(key, key === 'windowMinutes' ? Number(e.target.value) : e.target.value)}>{options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</Form.Select><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        }
        return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}</Form.Label><Form.Control value={form[key]} onChange={(e) => onNumericChange(key, e.target.value)} onBlur={() => onNumericBlur(key)} /><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
      })}
      <Button onClick={onStart}>Create</Button>

      <Card className='mt-3'><Card.Body><div className='d-flex justify-content-between'><strong>Signals</strong><Badge bg='secondary'>3</Badge></div>
        <Table size='sm'><tbody>{latestSignals.map((n, idx) => <tr key={`${n.symbol}-${idx}`}><td>{n.symbol}</td><td>{n.action}</td><td>{n.message}</td></tr>)}</tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>

    <Col md={8}><Card><Card.Body>
      <Card.Title>Bots summary</Card.Title>
      <Table size='sm'><thead><tr><th>ID</th><th>Status</th><th>Config</th><th>Action</th></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id}</td><td><Badge bg={i.status === 'RUNNING' ? 'success' : 'secondary'}>{i.status}</Badge></td><td>trades={i.tradesCount || 0} | winrate={Number(i.winratePct || 0).toFixed(1)}% | pnl={Number(i.pnl || 0).toFixed(2)}</td><td className='d-flex gap-1'>
          {i.status === 'STOPPED' && <Button size='sm' variant='outline-success' onClick={async () => { const out = await ws.request('momentum.continue', { instanceId: i.id }); if (!out?.ok) alert(out?.error || 'continue failed'); loadSelected(i.id); }}>Continue</Button>}
          <Button size='sm' onClick={() => loadStats(i.id)}>View stats</Button>
          <Button size='sm' variant='outline-danger' onClick={async () => { await ws.request('momentum.deleteInstance', { instanceId: i.id }); if (selectedId === i.id) setSelectedId(''); }}>Delete</Button>
        </td></tr>)}
      </tbody></Table>

      <h6>Зафиксированные сигналы</h6>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        <Table size='sm'><thead style={{ position: 'sticky', top: 0, background: 'white' }}><tr><th>time</th><th>symbol</th><th>side</th><th>action</th><th>reason</th></tr></thead><tbody>
          {fixedSignals.map((r) => <tr key={r.id}><td>{new Date(r.tsMs).toLocaleTimeString()}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.action}</td><td>{r.reason || '-'}</td></tr>)}
        </tbody></Table>
      </div>

      <h6 ref={statsRef}>Runs</h6>
      {statsError && <Alert variant='danger'>{statsError}</Alert>}
      <Table size='sm'><thead><tr><th>runId</th><th>startedAt</th><th>stoppedAt</th><th>mode</th><th>trades</th><th>winrate</th><th>pnl</th></tr></thead><tbody>
        {(statsView?.runs || []).map((r) => <tr key={r.runId}><td>{r.runId}</td><td>{new Date(r.startedAt).toLocaleString()}</td><td>{r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : '-'}</td><td>{r.mode}</td><td>{r.tradesCount}</td><td>{Number(r.winrate || 0).toFixed(1)}%</td><td>{Number(r.pnl || 0).toFixed(3)}</td></tr>)}
      </tbody></Table>

      <h6>Trades</h6>
      <Table size='sm'><thead><tr><th>time</th><th>runId</th><th>symbol</th><th>side</th><th>entry</th><th>exit</th><th>pnl</th></tr></thead><tbody>
        {(statsView?.trades || []).map((t) => <tr key={t.id}><td>{t.entryTs ? new Date(t.entryTs).toLocaleString() : '-'}</td><td>{t.runId || '-'}</td><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryPriceActual || t.entryPrice || '-'}</td><td>{t.exitPrice || '-'}</td><td>{Number(t.pnlNet ?? t.pnlUsd ?? 0).toFixed(3)}</td></tr>)}
      </tbody></Table>

      <Card className='mt-3'><Card.Body>
        <Card.Title>Inspector</Card.Title>
        <div className='d-flex gap-2 mb-2'><Form.Select value={inspectSymbol} onChange={(e) => setInspectSymbol(e.target.value)}>{universeSymbols.map((s) => <option key={s}>{s}</option>)}</Form.Select><Button onClick={refreshInspect}>Refresh</Button></div>
        {inspectError && <Alert variant='danger'>{inspectError}</Alert>}
        <Table size='sm'><thead><tr><th>Metric</th><th>Current</th><th>Threshold</th><th>PASS/FAIL</th><th>Reason</th></tr></thead><tbody>
          {metricKeys.map((key) => <tr key={key}><td>{key}</td><td>{inspectData?.metrics?.[key]?.human || '-'}</td><td>{inspectData?.thresholds?.[key] ? `${inspectData.thresholds[key].op} ${inspectData.thresholds[key].value}` : '—'}</td><td>{inspectData?.checks?.[key]?.status || (inspectData?.checks?.[key]?.pass ? 'PASS' : 'INFO')}</td><td>{inspectData?.checks?.[key]?.reason || '—'}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>
  </Row>;
}

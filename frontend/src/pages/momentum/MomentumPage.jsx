import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';
import { DEFAULT_MOMENTUM_FORM } from './defaults.js';
import { MOMENTUM_FIELD_META } from './fieldMeta.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const DRAFT_KEY = 'momentumDraftConfig';
const NUMERIC_FIELDS = ['windowMinutes', 'turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'entryOffsetPct', 'marginUsd', 'leverage', 'tpRoiPct', 'slRoiPct', 'cooldownMinutes', 'maxNewEntriesPerTick'];

const toFormStrings = (cfg = {}) => ({ ...DEFAULT_MOMENTUM_FORM, ...cfg, ...Object.fromEntries(NUMERIC_FIELDS.map((key) => [key, String(cfg?.[key] ?? DEFAULT_MOMENTUM_FORM[key] ?? '')])) });
const normalizeTierIndices = (arr) => [...new Set((arr || []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
const parseNumericPatch = (key, raw) => {
  const next = String(raw ?? '').trim();
  if (next === '') return { hasValue: false, value: null };
  const n = Number(next);
  return { hasValue: Number.isFinite(n), value: n };
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
  const [universeSymbols, setUniverseSymbols] = useState([]);
  const [universeTiers, setUniverseTiers] = useState([]);
  const [inspectSymbol, setInspectSymbol] = useState('');
  const [inspectData, setInspectData] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const statsRef = useRef(null);
  const debounceRef = useRef(new Map());

  const persistPatch = useCallback(async (patch = {}) => {
    if (!Object.keys(patch).length) return;
    if (selectedId) {
      await ws.request('momentum.updateInstanceConfig', { instanceId: selectedId, patch });
      return;
    }
    const merged = { ...DEFAULT_MOMENTUM_FORM, ...JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'), ...patch };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(merged));
  }, [selectedId, ws]);

  const loadUniverse = useCallback(async () => {
    try {
      const [tiersRes, listRes] = await Promise.all([
        fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()),
        fetch(`${API_BASE}/api/universe/list`).then((r) => r.json()),
      ]);
      const tiers = tiersRes?.outputs?.tiers || [];
      setUniverseTiers(tiers);
      setUniverseSymbols(listRes?.symbols || []);
      if (!inspectSymbol && listRes?.symbols?.[0]) setInspectSymbol(listRes.symbols[0]);
    } catch {
      setUniverseTiers([]);
      setUniverseSymbols([]);
    }
  }, [inspectSymbol]);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    const [state, fs, ls] = await Promise.all([
      ws.request('momentum.getInstanceState', { instanceId: id }),
      ws.request('momentum.getFixedSignals', { instanceId: id, limit: 200 }),
      ws.request('momentum.getSignals', { instanceId: id, limit: 3 }),
    ]);
    if (state?.ok) {
      setForm(toFormStrings(state.stateSnapshot?.config || {}));
    }
    if (fs?.ok) {
      const sorted = [...(fs.rows || [])].sort((a, b) => Number(b.tsMs || 0) - Number(a.tsMs || 0));
      setFixedSignals(sorted);
    }
    if (ls?.ok) setLatestSignals((ls.rows || []).slice(0, 3));
  }, [ws]);

  useEffect(() => { loadUniverse(); }, [loadUniverse]);

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

  const setField = useCallback((key, value) => setForm((p) => ({ ...p, [key]: value })), []);

  const onImmediateChange = useCallback(async (key, value) => {
    setField(key, value);
    await persistPatch({ [key]: value });
  }, [persistPatch, setField]);

  const onNumericChange = useCallback((key, raw) => {
    setField(key, raw);
    const oldTimer = debounceRef.current.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    const timer = setTimeout(async () => {
      const parsed = parseNumericPatch(key, raw);
      if (parsed.hasValue) await persistPatch({ [key]: parsed.value });
    }, 400);
    debounceRef.current.set(key, timer);
  }, [persistPatch, setField]);

  const onNumericBlur = useCallback(async (key) => {
    const parsed = parseNumericPatch(key, form[key]);
    const fallback = Number(DEFAULT_MOMENTUM_FORM[key] || 0);
    const normalized = parsed.hasValue ? parsed.value : fallback;
    setField(key, String(normalized));
    await persistPatch({ [key]: normalized });
  }, [form, persistPatch, setField]);

  const onStart = async () => {
    const payload = {
      ...DEFAULT_MOMENTUM_FORM,
      ...form,
      tierIndices: normalizeTierIndices(form.tierIndices),
      singleSymbol: form.singleSymbol || '',
      globalSymbolLock: Boolean(form.globalSymbolLock),
    };
    for (const key of NUMERIC_FIELDS) payload[key] = Number(form[key]);
    const out = await ws.request('momentum.start', { config: payload });
    if (out?.ok) setSelectedId(out.instanceId);
  };

  const loadStats = async (botId) => {
    setStatsError('');
    setSelectedId(botId);
    try {
      const res = await fetch(`${API_BASE}/api/momentum/bots/${botId}/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatsView(await res.json());
    } catch (err) {
      setStatsError(String(err?.message || err));
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
      setInspectData(null);
    }
  };

  const selectedTierCount = useMemo(() => {
    const selected = new Set(normalizeTierIndices(form.tierIndices));
    return universeTiers.filter((t) => selected.has(Number(t.tierIndex))).reduce((sum, t) => sum + (t.symbols?.length || 0), 0);
  }, [form.tierIndices, universeTiers]);

  const metricKeys = useMemo(() => {
    const t = Object.keys(inspectData?.thresholds || {});
    const m = Object.keys(inspectData?.metrics || {});
    return [...new Set([...t, ...m])];
  }, [inspectData]);

  return <Row className='g-3'>
    <Col md={4}><Card><Card.Body>
      <Card.Title>Momentum Settings</Card.Title>

      <h6 className='mt-2'>Universe / Scan scope</h6>
      <Form.Group className='mb-2'>
        <Form.Label>{MOMENTUM_FIELD_META.scanMode.label}<div className='text-muted small'>scanMode</div></Form.Label>
        <Form.Select value={form.scanMode} onChange={(e) => onImmediateChange('scanMode', e.target.value)}>
          <option value='UNIVERSE'>UNIVERSE</option><option value='SINGLE'>SINGLE</option>
        </Form.Select>
        <Form.Text className='text-muted'>{MOMENTUM_FIELD_META.scanMode.help}</Form.Text>
      </Form.Group>

      {form.scanMode === 'UNIVERSE' ? <>
        <Form.Group className='mb-2'>
          <Form.Label>{MOMENTUM_FIELD_META.universeSource.label}<div className='text-muted small'>universeSource</div></Form.Label>
          <Form.Select value={form.universeSource} onChange={(e) => onImmediateChange('universeSource', e.target.value)}>
            <option value='TIER_1'>TIER_1</option><option value='TIER_2'>TIER_2</option>
          </Form.Select>
          <Form.Text className='text-muted'>{MOMENTUM_FIELD_META.universeSource.help}</Form.Text>
        </Form.Group>
        <Form.Group className='mb-2'>
          <Form.Label>{MOMENTUM_FIELD_META.tierIndices.label}<div className='text-muted small'>tierIndices</div></Form.Label>
          <Form.Select multiple value={(form.tierIndices || []).map(String)} onChange={(e) => {
            const next = [...e.target.selectedOptions].map((opt) => Number(opt.value));
            setField('tierIndices', next);
            persistPatch({ tierIndices: normalizeTierIndices(next) });
          }}>
            {universeTiers.map((t) => <option key={t.tierIndex} value={t.tierIndex}>tier {t.tierIndex} ({t.symbols?.length || 0})</option>)}
          </Form.Select>
          <Form.Text className='text-muted'>{MOMENTUM_FIELD_META.tierIndices.help}</Form.Text>
        </Form.Group>
        <Form.Text className='text-muted d-block mb-3'>resolvedSymbolsCount: {selectedTierCount}</Form.Text>
      </> : <Form.Group className='mb-3'>
        <Form.Label>{MOMENTUM_FIELD_META.singleSymbol.label}<div className='text-muted small'>singleSymbol</div></Form.Label>
        <Form.Select value={form.singleSymbol || ''} onChange={(e) => onImmediateChange('singleSymbol', e.target.value)}>
          <option value=''>Select symbol</option>
          {universeSymbols.map((s) => <option key={s}>{s}</option>)}
        </Form.Select>
        <Form.Text className='text-muted'>{MOMENTUM_FIELD_META.singleSymbol.help}</Form.Text>
      </Form.Group>}

      {['mode', 'directionMode', 'windowMinutes', 'turnover24hMin', 'vol24hMin', 'priceThresholdPct', 'oiThresholdPct', 'turnoverSpikePct', 'baselineFloorUSDT', 'holdSeconds', 'trendConfirmSeconds', 'oiMaxAgeSec', 'leverage', 'marginUsd', 'tpRoiPct', 'slRoiPct', 'entryOffsetPct', 'cooldownMinutes', 'maxNewEntriesPerTick', 'entryPriceSource', 'globalSymbolLock'].map((key) => {
        const meta = MOMENTUM_FIELD_META[key];
        if (key === 'globalSymbolLock') {
          return <Form.Group key={key} className='mb-2'><Form.Check type='switch' label={meta.label} checked={Boolean(form[key])} onChange={(e) => onImmediateChange(key, e.target.checked)} /><div className='text-muted small'>{key}</div><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        }
        if (key === 'mode' || key === 'directionMode' || key === 'entryPriceSource') {
          const options = key === 'mode' ? ['paper', 'demo', 'real'] : (key === 'directionMode' ? ['LONG', 'SHORT', 'BOTH'] : ['MARK', 'LAST']);
          return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}<div className='text-muted small'>{key}</div></Form.Label><Form.Select value={form[key]} onChange={(e) => onImmediateChange(key, e.target.value)}>{options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}</Form.Select><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
        }
        return <Form.Group key={key} className='mb-2'><Form.Label>{meta.label}<div className='text-muted small'>{key}</div></Form.Label><Form.Control value={form[key]} onChange={(e) => onNumericChange(key, e.target.value)} onBlur={() => onNumericBlur(key)} /><Form.Text className='text-muted'>{meta.help}</Form.Text></Form.Group>;
      })}

      <Button onClick={onStart}>Create</Button>
      <Card className='mt-3'><Card.Body>
        <div className='d-flex justify-content-between align-items-center'><strong>Latest Signals</strong><Badge bg='secondary'>max 3</Badge></div>
        <Table size='sm'><tbody>{latestSignals.map((n, idx) => <tr key={`${n.symbol}-${n.action}-${idx}`}><td>{n.symbol}</td><td>{n.action}</td><td>{n.message}</td></tr>)}</tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>

    <Col md={8}><Card><Card.Body>
      <Card.Title>Bots summary</Card.Title>
      <Table size='sm'><thead><tr><th>ID</th><th>Status</th><th>Config</th><th>Action</th></tr></thead><tbody>
        {instances.map((i) => <tr key={i.id}><td>{i.id}</td><td><Badge bg={i.status === 'RUNNING' ? 'success' : 'secondary'}>{i.status}</Badge></td><td>mode={i.mode} | trades={i.tradesCount || 0} | winrate={Number(i.winratePct || 0).toFixed(1)}% | pnl={Number(i.pnl || 0) >= 0 ? '+' : ''}{Number(i.pnl || 0).toFixed(2)}</td><td className='d-flex gap-1'>
          {i.status === 'STOPPED' && <Button size='sm' variant='outline-success' onClick={async () => { await ws.request('momentum.continue', { instanceId: i.id }); loadSelected(i.id); }}>Continue</Button>}
          <Button size='sm' onClick={() => loadStats(i.id)}>View stats</Button>
          <Button size='sm' variant='outline-danger' onClick={async () => { await ws.request('momentum.deleteInstance', { instanceId: i.id }); if (selectedId === i.id) { setSelectedId(''); setStatsView(null); } }}>Delete</Button>
        </td></tr>)}
      </tbody></Table>

      <h6>Fixed signals</h6>
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <Table size='sm'><thead style={{ position: 'sticky', top: 0, background: 'white' }}><tr><th>time</th><th>symbol</th><th>side</th><th>action</th><th>reason</th></tr></thead><tbody>
          {fixedSignals.map((r) => <tr key={r.id}><td>{new Date(r.tsMs).toLocaleTimeString()}</td><td>{r.symbol}</td><td>{r.side}</td><td>{r.action}</td><td>{r.reason || '-'}</td></tr>)}
        </tbody></Table>
      </div>

      <h6 ref={statsRef}>Runs</h6>
      {statsError && <Alert variant='danger'>View stats error: {statsError}</Alert>}
      {!statsError && statsView && (statsView.runs || []).length === 0 && <Alert variant='info'>No runs found for this bot yet.</Alert>}
      <Table size='sm'><thead><tr><th>runId</th><th>startedAt</th><th>stoppedAt</th><th>mode</th><th>trades</th><th>winrate</th><th>pnl</th></tr></thead><tbody>
        {(statsView?.runs || []).map((r) => <tr key={r.runId}><td>{r.runId}</td><td>{new Date(r.startedAt).toLocaleString()}</td><td>{r.stoppedAt ? new Date(r.stoppedAt).toLocaleString() : '-'}</td><td>{r.mode}</td><td>{r.tradesCount}</td><td>{Number(r.winrate || 0).toFixed(1)}%</td><td>{Number(r.pnl || 0).toFixed(3)}</td></tr>)}
      </tbody></Table>

      <h6>Trades</h6>
      {!statsError && statsView && (statsView.trades || []).length === 0 && <Alert variant='info'>No trades found for this bot yet.</Alert>}
      <Table size='sm'><thead><tr><th>time</th><th>runId</th><th>symbol</th><th>side</th><th>entryPrice</th><th>exitPrice</th><th>pnlUsd</th><th>fees</th><th>outcome</th></tr></thead><tbody>
        {(statsView?.trades || []).map((t) => <tr key={t.id}><td>{t.entryTs ? new Date(t.entryTs).toLocaleString() : '-'}</td><td>{t.runId || '-'}</td><td>{t.symbol}</td><td>{t.side}</td><td>{t.entryPriceActual || t.entryPrice || '-'}</td><td>{t.exitPrice || '-'}</td><td>{Number(t.pnlNet ?? t.pnlUsd ?? 0).toFixed(3)}</td><td>{Number(t.fees ?? 0).toFixed(4)}</td><td>{t.outcome || '-'}</td></tr>)}
      </tbody></Table>

      <Card className='mt-3'><Card.Body>
        <Card.Title>Inspector</Card.Title>
        <div className='d-flex gap-2 mb-2'><Form.Select value={inspectSymbol} onChange={(e) => setInspectSymbol(e.target.value)}>{universeSymbols.map((s) => <option key={s}>{s}</option>)}</Form.Select><Button onClick={refreshInspect}>Refresh</Button></div>
        {inspectError && <Alert variant='danger'>{inspectError}</Alert>}
        <Table size='sm'><thead><tr><th>Metric</th><th>Current</th><th>Threshold</th><th>PASS/FAIL</th><th>Reason</th></tr></thead><tbody>
          {metricKeys.map((key) => <tr key={key}><td>{key}</td><td>{inspectData?.metrics?.[key]?.human || '-'}</td><td>{inspectData?.thresholds?.[key] ? `${inspectData.thresholds[key].op} ${inspectData.thresholds[key].value}` : '-'}</td><td>{inspectData?.checks?.[key]?.pass ? 'PASS' : 'FAIL'}</td><td>{inspectData?.checks?.[key]?.reason || '-'}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
    </Card.Body></Card></Col>
  </Row>;
}

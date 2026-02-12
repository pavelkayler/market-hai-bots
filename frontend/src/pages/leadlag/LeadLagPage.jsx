import { useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—'; }
function fmtPf(v) { return v === Infinity ? '∞' : fmt(v, 3); }
function normalizeSymbol(sym) { return String(sym || '').toUpperCase().trim().replace(/[/-]/g, ''); }

const defaultSettings = { leaderSymbol: 'BTCUSDT', followerSymbol: 'ETHUSDT', leaderMovePct: 0.1, followerTpPct: 0.1, followerSlPct: 0.1, allowShort: true, lagMs: 250 };
const lagOptions = [250, 500, 750, 1000];

export default function LeadLagPage() {
  const [state, setState] = useState({ status: 'STOPPED', search: { phase: 'idle' } });
  const [rows, setRows] = useState([]);
  const [searchActive, setSearchActive] = useState(false);
  const [sort, setSort] = useState({ key: 'corr', dir: 'desc' });
  const [universe, setUniverse] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [autoTuneConfig, setAutoTuneConfig] = useState({ enabled: true, evalWindowTrades: 20, minTradesToStart: 10, minProfitFactor: 1, minExpectancy: 0, tpStepPct: 0.05, tpMinPct: 0.05, tpMaxPct: 0.5 });

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type === 'event' ? msg.topic : msg.type;
    const payload = msg.payload;
    if (type === 'snapshot') {
      if (payload?.leadlagState) {
        setState(payload.leadlagState);
        if (payload.leadlagState?.settings) setSettings((prev) => ({ ...prev, ...payload.leadlagState.settings }));
        if (payload.leadlagState?.autoTuneConfig) setAutoTuneConfig((prev) => ({ ...prev, ...payload.leadlagState.autoTuneConfig }));
      }
      const snapSymbols = Array.isArray(payload?.universeList?.symbols) ? payload.universeList.symbols : [];
      if (snapSymbols.length) setUniverse(snapSymbols.map(normalizeSymbol));
    }
    if (type === 'leadlag.state') {
      setState((prev) => ({ ...(prev || {}), ...(payload || {}) }));
      if (payload?.settings) setSettings((prev) => ({ ...prev, ...payload.settings }));
      if (payload?.autoTuneConfig) setAutoTuneConfig((prev) => ({ ...prev, ...payload.autoTuneConfig }));
    }
    if (type === 'leadlag.top') {
      const topRows = Array.isArray(payload?.topRows) ? payload.topRows : (Array.isArray(payload?.screeningTopRows) ? payload.screeningTopRows : []);
      setRows(topRows.slice(0, 50));
      setState((prev) => ({ ...(prev || {}), search: payload || {} }));
      setSearchActive(Boolean(payload?.searchActive));
    }
    if (type === 'leadlag.settingsUpdated') {
      const nextSettings = payload?.settings || {};
      setSettings((prev) => ({ ...prev, ...nextSettings }));
      setState((prev) => ({ ...(prev || {}), settings: { ...(prev?.settings || {}), ...nextSettings } }));
    }
    if (type === 'leadlag.search.ack') {
      setSearchActive(Boolean(payload?.active));
      if (payload?.state) setState((prev) => ({ ...(prev || {}), search: payload.state }));
    }
    if (type === 'universe.updated') setUniverse(Array.isArray(payload?.symbols) ? payload.symbols.map(normalizeSymbol) : []);
    if (type === 'leadlag.learningLog') setState((prev) => ({ ...(prev || {}), learningLog: Array.isArray(payload) ? payload : [] }));
  }, []);

  const { status, sendJson } = useWsClient({ onOpen: () => { sendJson({ type: 'getLeadLagState' }); sendJson({ type: 'getSnapshot' }); sendJson({ type: 'leadlag.getLearningLog' }); }, onMessage });

  const universeSet = useMemo(() => new Set(universe), [universe]);
  const isLeaderValid = universeSet.has(normalizeSymbol(settings.leaderSymbol));
  const isFollowerValid = universeSet.has(normalizeSymbol(settings.followerSymbol));
  const universeReady = universe.length > 0;
  const canStart = status === 'connected' && universeReady && isLeaderValid && isFollowerValid;
  const search = state?.search || {};
  const progressPct = Math.max(0, Math.min(100, Number(search?.pct || 0)));

  const sortedRows = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a?.[sort.key];
      const bv = b?.[sort.key];
      if (typeof av === 'string' || typeof bv === 'string') return String(av || '').localeCompare(String(bv || '')) * dir;
      return (Number(av || 0) - Number(bv || 0)) * dir;
    });
  }, [rows, sort]);

  const learningLog = Array.isArray(state?.learningLog) ? state.learningLog : [];
  const runSummary = Array.isArray(state?.runSummary) ? state.runSummary : [];
  const lastEvaluation = state?.lastEvaluation || {};
  const decision = state?.learningLog?.[0]?.decision || '—';

  return <div className='d-grid gap-3'>
    <Card><Card.Body>
      <div className='d-flex align-items-center justify-content-between mb-2'>
        <div className='fw-semibold'>LeadLag Trading</div>
        <Badge bg={status === 'connected' ? 'success' : 'warning'}>{status}</Badge>
      </div>
      <datalist id='universe-list'>{universe.map((s) => <option key={s} value={s} />)}</datalist>
      <Row className='g-2'>
        <Col md={3}><Form.Group><Form.Label>Leader</Form.Label><Form.Control type='text' list='universe-list' value={settings.leaderSymbol || ''} onChange={(e) => setSettings((p) => ({ ...p, leaderSymbol: normalizeSymbol(e.target.value) }))} /></Form.Group></Col>
        <Col md={3}><Form.Group><Form.Label>Follower</Form.Label><Form.Control type='text' list='universe-list' value={settings.followerSymbol || ''} onChange={(e) => setSettings((p) => ({ ...p, followerSymbol: normalizeSymbol(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Leader move trigger (%)</Form.Label><Form.Control type='number' step='0.01' value={settings.leaderMovePct} onChange={(e) => setSettings((p) => ({ ...p, leaderMovePct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Follower TP (%)</Form.Label><Form.Control type='number' step='0.01' value={settings.followerTpPct} onChange={(e) => setSettings((p) => ({ ...p, followerTpPct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Follower SL (%)</Form.Label><Form.Control type='number' step='0.01' value={settings.followerSlPct} onChange={(e) => setSettings((p) => ({ ...p, followerSlPct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Lag (ms)</Form.Label><Form.Select value={settings.lagMs} onChange={(e) => setSettings((p) => ({ ...p, lagMs: Number(e.target.value) }))}>{lagOptions.map((x) => <option key={x} value={x}>{x}</option>)}</Form.Select></Form.Group></Col>
        <Col md={2}><Form.Check className='mt-4' label='Allow short' checked={Boolean(settings.allowShort)} onChange={(e) => setSettings((p) => ({ ...p, allowShort: e.target.checked }))} /></Col>
      </Row>
      {!universeReady ? <div className='small text-muted mt-2'>Universe loading…</div> : null}
      {universeReady && (!isLeaderValid || !isFollowerValid) ? <div className='small text-danger mt-2'>Выберите символы только из universe.</div> : null}

      <div className='d-flex gap-2 mt-3'>
        <Button disabled={!canStart} onClick={() => sendJson({ type: 'startLeadLag', settings })}>Start</Button>
        <Button variant='outline-warning' disabled={status === 'closed'} onClick={() => sendJson({ type: 'stopLeadLag' })}>Stop</Button>
        <Button variant='outline-danger' disabled={status === 'closed'} onClick={() => sendJson({ type: 'resetLeadLag' })}>Reset</Button>
        <Button variant={searchActive ? 'outline-danger' : 'outline-success'} disabled={status === 'closed'} onClick={() => sendJson({ type: searchActive ? 'stopLeadLagSearch' : 'startLeadLagSearch' })}>{searchActive ? 'Stop search' : 'Start search'}</Button>
      </div>

      <div className='small mt-3'>
        <div>Trades {Number(state?.stats?.trades || 0)} / Wins {Number(state?.stats?.wins || 0)} / Losses {Number(state?.stats?.losses || 0)} / Win rate {fmt(state?.stats?.winRate, 1)}% / PnL {fmt(state?.stats?.pnlUSDT, 3)}</div>
        <div>Fees {fmt(state?.stats?.feesUSDT, 3)} / Funding {fmt(state?.stats?.fundingUSDT, 3)} / Проскальзывание {fmt(state?.stats?.slippageUSDT, 3)} / FeeRate maker {fmt(state?.stats?.feeRateMaker, 4)}</div>
      </div>
    </Card.Body></Card>

    <Card><Card.Body>
      <div className='fw-semibold'>Search (Top-50)</div>
      <div className='small text-muted mb-2'>Phase: {search?.phase || 'idle'} · Warmup {Number(search?.symbolsReady || 0)}/{Number(search?.symbolsTotal || 0)} · Screening {Number(search?.processedPairs || 0)}/{Number(search?.totalPairs || 0)} · Confirmations {Number(search?.confirmationsProcessed || 0)}/{Number(search?.confirmationsTotal || 0)}</div>
      <div style={{ height: 10, background: '#eee', borderRadius: 6, overflow: 'hidden' }} className='mb-2'><div style={{ width: `${progressPct}%`, height: '100%', background: '#0d6efd', transition: 'width 0.2s linear' }} /></div>
      {search?.error ? <div className='small text-danger mb-2'>{search.error}</div> : null}

      <Table size='sm' style={{ tableLayout: 'fixed', width: '100%' }}>
        <colgroup><col style={{ width: '140px' }} /><col style={{ width: '140px' }} /><col style={{ width: '100px' }} /><col style={{ width: '100px' }} /><col style={{ width: '120px' }} /></colgroup>
        <thead><tr><th role='button' onClick={() => setSort((p) => ({ key: 'leader', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Leader</th><th role='button' onClick={() => setSort((p) => ({ key: 'follower', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Follower</th><th role='button' onClick={() => setSort((p) => ({ key: 'corr', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Corr</th><th role='button' onClick={() => setSort((p) => ({ key: 'lagMs', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Lag(ms)</th><th>Confirmations</th></tr></thead>
        <tbody>
          {sortedRows.slice(0, 50).map((r, i) => <tr key={`${r.leader}-${r.follower}-${i}`}><td style={{ whiteSpace: 'nowrap' }}>{r.leader}</td><td style={{ whiteSpace: 'nowrap' }}>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs, 0)}</td><td>{Number(r.confirmations || 0)}</td></tr>)}
        </tbody>
      </Table>
    </Card.Body></Card>

    <Card><Card.Body>
      <div className='fw-semibold mb-2'>Run summary / History</div>
      <Table size='sm'><thead><tr><th>Pair</th><th>Настройки</th><th>Подтверждения</th><th>Trades/W/L/WR</th><th>PnL</th><th>Fees</th><th>Funding</th><th>Slippage</th><th></th></tr></thead><tbody>
        {runSummary.length ? runSummary.map((r) => <tr key={r.runKey}><td>{r.pair}</td><td>{`trg:${r.settings?.leaderMovePct} tp:${r.settings?.followerTpPct} sl:${r.settings?.followerSlPct} short:${r.settings?.allowShort ? 'y' : 'n'} lag:${r.settings?.lagMs}`}</td><td>{r.confirmations || 0}</td><td>{r.trades}/{r.wins}/{r.losses}/{fmt(r.winRate, 1)}%</td><td>{fmt(r.pnlUSDT, 3)}</td><td>{fmt(r.feesUSDT, 3)}</td><td>{fmt(r.fundingUSDT, 3)}</td><td>{fmt(r.slippageUSDT, 3)}</td><td><Button size='sm' variant='outline-secondary' onClick={() => setSettings({ ...(r.settings || settings), tpSource: 'manual' })}>Copy</Button></td></tr>) : <tr><td colSpan={9} className='text-muted'>No run history</td></tr>}
      </tbody></Table>
    </Card.Body></Card>

    <Card><Card.Body className='d-grid gap-3'>
      <div className='d-flex align-items-center justify-content-between'>
        <div>
          <div className='fw-semibold'>Обучение (Auto-tune)</div>
          <div className='small text-muted'>Только закрытые сделки (CLOSE), single-change rule: по очереди меняем TP и lagMs.</div>
        </div>
        <Badge bg={state?.tuningStatus === 'frozen' ? 'info' : state?.tuningStatus === 'pending_eval' ? 'warning' : 'secondary'}>{state?.tuningStatus || 'idle'}</Badge>
      </div>

      <Row className='g-2'>
        <Col md={2}><Form.Check label='Auto-tune' checked={Boolean(autoTuneConfig.enabled)} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, enabled: e.target.checked }))} /></Col>
        <Col md={2}><Form.Group><Form.Label>Window trades</Form.Label><Form.Control type='number' value={autoTuneConfig.evalWindowTrades} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, evalWindowTrades: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Min trades</Form.Label><Form.Control type='number' value={autoTuneConfig.minTradesToStart} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, minTradesToStart: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Min PF</Form.Label><Form.Control type='number' step='0.01' value={autoTuneConfig.minProfitFactor} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, minProfitFactor: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>Min Exp</Form.Label><Form.Control type='number' step='0.0001' value={autoTuneConfig.minExpectancy} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, minExpectancy: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>TP step (%)</Form.Label><Form.Control type='number' step='0.01' value={autoTuneConfig.tpStepPct} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, tpStepPct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>TP min (%)</Form.Label><Form.Control type='number' step='0.01' value={autoTuneConfig.tpMinPct} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, tpMinPct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={2}><Form.Group><Form.Label>TP max (%)</Form.Label><Form.Control type='number' step='0.01' value={autoTuneConfig.tpMaxPct} onChange={(e) => setAutoTuneConfig((p) => ({ ...p, tpMaxPct: Number(e.target.value) }))} /></Form.Group></Col>
        <Col md={8} className='d-flex align-items-end gap-2'>
          <Button onClick={() => sendJson({ type: 'leadlag.setAutoTuneConfig', payload: autoTuneConfig })}>Apply</Button>
          <Button variant='outline-secondary' onClick={() => sendJson({ type: 'leadlag.getLearningLog' })}>Refresh log</Button>
          <Button variant='outline-danger' onClick={() => sendJson({ type: 'leadlag.clearLearningLog' })}>Clear log</Button>
        </Col>
      </Row>

      <div className='small text-muted'>Current window quality: PF {fmtPf(lastEvaluation?.profitFactor)} · Expectancy {fmt(lastEvaluation?.expectancy, 4)} · Trades {lastEvaluation?.trades || 0} / Wins {lastEvaluation?.wins || 0} / Losses {lastEvaluation?.losses || 0} · TotalPnL {fmt(lastEvaluation?.totalPnL, 4)} · Decision {decision}</div>

      <div className='fw-semibold'>Learning log (last 200)</div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <Table size='sm' striped hover>
          <thead><tr><th>Time</th><th>Event</th><th>Config</th><th>Metrics</th><th>Change</th><th>Reason</th></tr></thead>
          <tbody>
            {learningLog.length ? learningLog.map((row, idx) => {
              const m = row.metrics || {};
              const ch = row.change || {};
              return <tr key={`${row.ts || idx}-${idx}`}><td>{fmtTs(row.ts)}</td><td>{row.type || '—'}</td><td className='small'>{row.configSummary || row.configKey || '—'}</td><td className='small'>T:{m.trades ?? '—'} PF:{m.profitFactor === Infinity ? '∞' : fmt(m.profitFactor, 2)} Exp:{fmt(m.expectancy, 4)} PnL:{fmt(m.totalPnL, 3)}</td><td className='small'>{ch.paramName ? `${ch.paramName}: ${fmt(ch.from, 4)} → ${fmt(ch.to, 4)} (step ${fmt(ch.step, 4)})` : '—'}</td><td className='small'>{row.reason || '—'}</td></tr>;
            }) : <tr><td colSpan={6} className='text-muted'>No learning events yet</td></tr>}
          </tbody>
        </Table>
      </div>
    </Card.Body></Card>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Col, Form, ProgressBar, Row, Table } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—'; }
function fmtPf(v) { return v === Infinity ? '∞' : fmt(v, 3); }

const defaultSettings = { leaderSymbol: 'BTCUSDT', followerSymbol: 'ETHUSDT', leaderMovePct: 0.1, followerTpPct: 0.1, followerSlPct: 0.1, allowShort: true, lagMs: 250 };
const lagOptions = [250, 500, 750, 1000];

function calcSearchProgress(search = {}) {
  const phase = String(search.phase || 'idle');
  if (phase === 'finished' || phase === 'done') return 100;
  if (phase === 'idle') return 0;
  const warmup = Number(search.symbolsTotal || 0) > 0 ? Number(search.symbolsReady || 0) / Number(search.symbolsTotal || 1) : 0;
  const screening = Number(search.totalPairs || 0) > 0 ? Number(search.processedPairs || 0) / Number(search.totalPairs || 1) : 0;
  const confirmations = Number(search.confirmationsTarget || 0) > 0 ? Number(search.confirmationsDone || 0) / Number(search.confirmationsTarget || 1) : 0;
  if (phase === 'warmup') return Math.max(0, Math.min(20, warmup * 20));
  if (phase === 'screening') return Math.max(20, Math.min(80, 20 + screening * 60));
  if (phase === 'confirmations') return Math.max(80, Math.min(100, 80 + confirmations * 20));
  return Math.max(0, Math.min(100, Number(search.pct || 0) * (Number(search.pct || 0) <= 1 ? 100 : 1)));
}

export default function LeadLagPage() {
  const [state, setState] = useState({ schemaVersion: 1, trading: { status: 'STOPPED' }, search: { status: 'IDLE', progress: { phase: 'IDLE', done: 0, total: 0 } }, legacy: { status: 'STOPPED', search: { phase: 'idle' } } });
  const [formSettings, setFormSettings] = useState(defaultSettings);
  const [rows, setRows] = useState([]);
    const [autoTuneConfig, setAutoTuneConfig] = useState({ enabled: true, evalWindowTrades: 20, minTradesToStart: 10, minProfitFactor: 1, minExpectancy: 0, tpStepPct: 0.05, tpMinPct: 0.05, tpMaxPct: 0.5 });
  const [serverNow, setServerNow] = useState(0);
  const lastTopUpdateAtRef = useRef(0);

  const onMessage = useMemo(() => (_ev, msg) => {
    if (!msg) return;
    setServerNow(Date.now());
    const type = msg.type === 'event' ? msg.topic : msg.type;
    const payload = msg.payload;

    if (type === 'leadlag.state') {
      setState((prev) => ({ ...(prev || {}), ...(payload || {}) }));
      const nextRows = payload?.search?.results?.top || payload?.search?.topRows || payload?.legacy?.search?.topRows || [];
      if (Array.isArray(nextRows)) setRows((prevRows) => nextRows.slice(0, 50).map((r, idx) => ({ ...prevRows[idx], ...r })));
      if (payload?.legacy?.autoTuneConfig) setAutoTuneConfig((prev) => ({ ...prev, ...payload.legacy.autoTuneConfig }));
      return;
    }

    if (type === 'leadlag.searchProgress') {
      setState((prev) => ({ ...(prev || {}), search: { ...(prev?.search || {}), progress: { ...(prev?.search?.progress || {}), ...(payload || {}) } } }));
      return;
    }

    if (type === 'leadlag.searchResults') {
      const topRows = Array.isArray(payload?.top) ? payload.top : [];
      setRows(topRows.slice(0, 50));
      setState((prev) => ({ ...(prev || {}), search: { ...(prev?.search || {}), results: { ...(prev?.search?.results || {}), ...(payload || {}) } } }));
      return;
    }

    if (type === 'leadlag.tradeEvent' || type === 'leadlag.log') {
      setState((prev) => ({ ...(prev || {}), legacy: { ...(prev?.legacy || {}), currentTradeEvents: [payload, ...((prev?.legacy?.currentTradeEvents || []).slice(0, 49))] } }));
      return;
    }

    if (type === 'leadlag.top') {
      const topRows = Array.isArray(payload?.topRows) ? payload.topRows : [];
      const now = Date.now();
      if (now - lastTopUpdateAtRef.current >= 250) {
        setRows(topRows.slice(0, 50));
        lastTopUpdateAtRef.current = now;
      }
      setState((prev) => ({ ...(prev || {}), search: { ...(prev?.search || {}), ...(payload || {}) } }));
      return;
    }

    if (type === 'leadlag.start.ack' || type === 'leadlag.reset.ack') {
      if (payload?.state?.settings) setFormSettings((prev) => ({ ...prev, ...payload.state.settings }));
      return;
    }

    if (type === 'leadlag.settingsUpdated' && payload?.settings) {
      setState((prev) => ({ ...(prev || {}), settings: { ...(prev?.settings || {}), ...payload.settings } }));
      return;
    }

    if (type === 'leadlag.learningLog') setState((prev) => ({ ...(prev || {}), learningLog: Array.isArray(payload) ? payload : [] }));
  }, []);

  const { status, sendJson, request, subscribeTopics, unsubscribeTopics } = useWsClient({
    onMessage,
  });

  useEffect(() => {
    if (status !== 'connected') return;
    subscribeTopics?.(['leadlag.*']);
    request('leadlag.getState');
    sendJson({ type: 'leadlag.getLearningLog' });
    return () => unsubscribeTopics?.(['leadlag.*']);
  }, [status, subscribeTopics, unsubscribeTopics, request, sendJson]);

  const canStart = status === 'connected' && String(formSettings.leaderSymbol || '').trim().length > 0 && String(formSettings.followerSymbol || '').trim().length > 0;
  const trading = state?.trading || {};
  const search = state?.search || {};
  const legacy = state?.legacy || {};
  const searchStatus = String(search?.status || search?.phase || 'IDLE').toUpperCase();
  const isSearchRunning = ['WARMUP', 'SCREENING', 'CONFIRMATIONS'].includes(searchStatus);
  const progressDone = Number(search?.progress?.done || 0);
  const progressTotalRaw = Number(search?.progress?.total || 0);
  const progressTotal = isSearchRunning && progressTotalRaw <= 0 ? Math.max(1, Number(search?.symbolsTotal || 1)) : progressTotalRaw;
  const progressPct = Number(search?.progress?.pct || calcSearchProgress(search));
  const positions = Array.isArray(legacy?.positions) ? legacy.positions : [];
  const followerPx = Number(legacy?.manual?.followerPrice);
  const currentTradeEvents = Array.isArray(legacy?.currentTradeEvents) ? legacy.currentTradeEvents : [];
  const currentClosedTrades = Array.isArray(legacy?.currentClosedTrades) ? legacy.currentClosedTrades : [];
  const learningLog = Array.isArray(legacy?.learningLog) ? legacy.learningLog : [];
  const runSummary = Array.isArray(legacy?.runSummary) ? legacy.runSummary : [];
  const lastEvaluation = legacy?.lastEvaluation || {};
  const decision = legacy?.learningLog?.[0]?.decision || '—';

  return <div className='d-grid gap-3'>
    <Row className='g-3'>
      <Col lg={6}>
        <Card><Card.Body>
          <div className='d-flex align-items-center justify-content-between mb-2'>
            <div className='fw-semibold'>LeadLag Trading</div>
            <div className='d-flex gap-2 align-items-center'>
              <Badge bg={status === 'connected' ? 'success' : 'warning'}>{status}</Badge>
              <Badge bg={trading?.status === 'RUNNING' ? 'success' : trading?.status === 'STARTING' ? 'warning' : 'secondary'}>{trading?.status || 'STOPPED'}</Badge>
            </div>
          </div>
          <Row className='g-2'>
            <Col md={6}><Form.Group><Form.Label>Leader</Form.Label><Form.Control type='text' value={formSettings.leaderSymbol || ''} onChange={(e) => setFormSettings((p) => ({ ...p, leaderSymbol: e.target.value }))} /></Form.Group></Col>
            <Col md={6}><Form.Group><Form.Label>Follower</Form.Label><Form.Control type='text' value={formSettings.followerSymbol || ''} onChange={(e) => setFormSettings((p) => ({ ...p, followerSymbol: e.target.value }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Leader move (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.leaderMovePct} onChange={(e) => setFormSettings((p) => ({ ...p, leaderMovePct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>TP (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.followerTpPct} onChange={(e) => setFormSettings((p) => ({ ...p, followerTpPct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>SL (%)</Form.Label><Form.Control type='number' step='0.01' value={formSettings.followerSlPct} onChange={(e) => setFormSettings((p) => ({ ...p, followerSlPct: Number(e.target.value) }))} /></Form.Group></Col>
            <Col md={4}><Form.Group><Form.Label>Lag (ms)</Form.Label><Form.Select value={formSettings.lagMs} onChange={(e) => setFormSettings((p) => ({ ...p, lagMs: Number(e.target.value) }))}>{lagOptions.map((x) => <option key={x} value={x}>{x}</option>)}</Form.Select></Form.Group></Col>
            <Col md={4} className='d-flex align-items-end'><Form.Check label='Allow short' checked={Boolean(formSettings.allowShort)} onChange={(e) => setFormSettings((p) => ({ ...p, allowShort: e.target.checked }))} /></Col>
            <Col md={12} className='d-flex gap-2'>
              <Button disabled={!canStart} onClick={() => request('leadlag.trading.start', { ...formSettings, leader: formSettings.leaderSymbol, follower: formSettings.followerSymbol })}>Start trading</Button>
              <Button variant='outline-secondary' onClick={() => request('leadlag.trading.stop', {})}>Stop</Button>
              <Button variant='outline-danger' onClick={() => request('leadlag.trading.reset', {})}>Reset</Button>
            </Col>
          </Row>
        </Card.Body></Card>
      </Col>

      <Col lg={6}>
        <Card><Card.Body className='d-grid gap-3'>
          <div className='fw-semibold'>Trading diagnostics</div>
          <div className='small'>Pair: {(legacy?.settings?.leaderSymbol || formSettings.leaderSymbol || '—')} / {(legacy?.settings?.followerSymbol || formSettings.followerSymbol || '—')}</div>
          <div className='small'>Leader px {fmt(legacy?.manual?.leaderPrice)} · Follower px {fmt(legacy?.manual?.followerPrice)} · Baseline {fmt(legacy?.manual?.leaderBaseline)} · Leader move now {fmt(legacy?.manual?.leaderMovePctNow, 2)}%</div>
          <div className='small'>Positions: {positions.length}/5</div>
          <div className='small'>Fees {fmt(legacy?.stats?.feesUSDT)} · Funding {fmt(legacy?.stats?.fundingUSDT)} · Slippage {fmt(legacy?.stats?.slippageUSDT)}<br />feeRateMaker {fmt(legacy?.stats?.feeRateMaker, 6)}</div>
          <div style={{ maxHeight: 160, overflow: 'auto' }}>
            <Table size='sm'>
              <thead><tr><th>Side</th><th>Entry</th><th>Qty</th><th>TP/SL</th><th>Unrealized</th><th>Age</th></tr></thead>
              <tbody>
                {positions.length ? positions.map((p) => {
                  const sideSign = p?.side === 'SHORT' ? -1 : 1;
                  const unreal = Number.isFinite(followerPx) ? ((followerPx - Number(p.entryPrice || 0)) * Number(p.qty || 0) * sideSign) : null;
                  const ageSec = Number.isFinite(Number(p?.openedAt)) && Number(serverNow) > 0 ? Math.max(0, (Number(serverNow) - Number(p.openedAt)) / 1000) : null;
                  return <tr key={p.id}><td>{p.side}</td><td>{fmt(p.entryPrice, 4)}</td><td>{fmt(p.qty, 4)}</td><td>{fmt(p.tpPrice, 4)} / {fmt(p.slPrice, 4)}</td><td>{fmt(unreal, 4)}</td><td>{Number.isFinite(ageSec) ? `${Math.round(ageSec)}s` : '—'}</td></tr>;
                }) : <tr><td colSpan={6} className='text-muted'>No open positions</td></tr>}
              </tbody>
            </Table>
          </div>

          <div className='fw-semibold'>Trade events (last 20, current run)</div>
          <div style={{ maxHeight: 180, overflow: 'auto' }}>
            <Table size='sm'>
              <thead><tr><th>Time</th><th>Event</th><th>Symbol</th><th>Side</th><th>Price</th><th>PnL</th></tr></thead>
              <tbody>
                {currentTradeEvents.length ? currentTradeEvents.map((e, idx) => <tr key={`${e.ts}-${idx}`}><td>{fmtTs(e.ts)}</td><td>{e.event}</td><td>{e.symbol}</td><td>{e.side || '—'}</td><td>{fmt(e.exitPrice ?? e.entryPrice, 4)}</td><td>{fmt(e.pnlUSDT, 4)}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No events in current run</td></tr>}
              </tbody>
            </Table>
          </div>

          <div className='fw-semibold'>Trade history (closed trades, current pair/current run)</div>
          <div style={{ maxHeight: 180, overflow: 'auto' }}>
            <Table size='sm'>
              <thead><tr><th>Closed</th><th>Side</th><th>Entry</th><th>Exit</th><th>Qty</th><th>PnL</th><th>Fees</th><th>Funding</th><th>Slip</th><th>Reason</th><th>Dur(s)</th></tr></thead>
              <tbody>
                {currentClosedTrades.length ? currentClosedTrades.map((t, idx) => <tr key={`${t.closedAt}-${idx}`}><td>{fmtTs(t.closedAt)}</td><td>{t.side}</td><td>{fmt(t.entryPrice, 4)}</td><td>{fmt(t.exitPrice, 4)}</td><td>{fmt(t.qty, 4)}</td><td>{fmt(t.pnl, 4)}</td><td>{fmt(t.fees, 4)}</td><td>{fmt(t.funding, 4)}</td><td>{fmt(t.slippage, 4)}</td><td>{t.reason || '—'}</td><td>{fmt(t.durationSec, 1)}</td></tr>) : <tr><td colSpan={11} className='text-muted'>No closed trades in current run</td></tr>}
              </tbody>
            </Table>
          </div>
        </Card.Body></Card>
      </Col>
    </Row>

    <Card><Card.Body>
      <div className='d-flex align-items-center justify-content-between mb-2'>
        <div className='fw-semibold'>Search (Top-50)</div>
        <div className='d-flex gap-2'>
          <Button size='sm' disabled={isSearchRunning || !['IDLE','FINISHED','ERROR'].includes(searchStatus) || status !== 'connected'} onClick={() => request('leadlag.search.start', {})}>Start search</Button>
          <Button size='sm' variant='outline-danger' disabled={!isSearchRunning || status !== 'connected'} onClick={() => request('leadlag.search.stop', {})}>Stop search</Button>
        </div>
      </div>
      <div className='small mb-1'>Phase: {searchStatus} · {progressDone}/{progressTotal} · Last update age: {Math.max(0, Math.floor((Date.now() - Number(search?.progress?.lastTickMs || search?.updatedAtMs || Date.now())) / 1000))}s</div>
      <ProgressBar now={progressPct} label={`${Math.round(progressPct)}%`} className='mb-2' />
      <Table size='sm' style={{ tableLayout: 'fixed' }}>
        <colgroup><col style={{ width: '25%' }} /><col style={{ width: '25%' }} /><col style={{ width: '15%' }} /><col style={{ width: '15%' }} /><col style={{ width: '20%' }} /></colgroup>
        <thead><tr><th>Leader</th><th>Follower</th><th>Corr</th><th>Lag(ms)</th><th>Confirmations</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={`${r.leader}_${r.follower}`}><td style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.leader}</td><td style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.follower}</td><td>{Number.isFinite(Number(r.corr)) ? fmt(r.corr, 3) : '—'}</td><td>{fmt(r.lagMs, 0)}</td><td>{Number(r.confirmations || 0)}</td></tr>)}
        </tbody>
      </Table>
    </Card.Body></Card>

    <Card><Card.Body>
      <div className='fw-semibold mb-2'>Run summary / History</div>
      <Table size='sm'><thead><tr><th>Pair</th><th>Настройки</th><th>Подтверждения</th><th>Trades/W/L/WR</th><th>PnL</th><th>Fees</th><th>Funding</th><th>Slippage</th><th></th></tr></thead><tbody>
        {runSummary.length ? runSummary.map((r) => <tr key={r.runKey}><td>{r.pair}</td><td>{`trg:${r.settings?.leaderMovePct} tp:${r.settings?.followerTpPct} sl:${r.settings?.followerSlPct} short:${r.settings?.allowShort ? 'y' : 'n'} lag:${r.settings?.lagMs}`}</td><td>{r.confirmations || 0}</td><td>{r.trades}/{r.wins}/{r.losses}/{fmt(r.winRate, 1)}%</td><td>{fmt(r.pnlUSDT, 3)}</td><td>{fmt(r.feesUSDT, 3)}</td><td>{fmt(r.fundingUSDT, 3)}</td><td>{fmt(r.slippageUSDT, 3)}</td><td><Button size='sm' variant='outline-secondary' onClick={() => setFormSettings({ ...(r.settings || formSettings), tpSource: 'manual' })}>Copy</Button></td></tr>) : <tr><td colSpan={9} className='text-muted'>No run history</td></tr>}
      </tbody></Table>
    </Card.Body></Card>

    <Card><Card.Body className='d-grid gap-3'>
      <div className='d-flex align-items-center justify-content-between'>
        <div>
          <div className='fw-semibold'>Обучение (Auto-tune)</div>
          <div className='small text-muted'>Только закрытые сделки (CLOSE), single-change rule: по очереди меняем TP и lagMs.</div>
        </div>
        <Badge bg={legacy?.tuningStatus === 'frozen' ? 'info' : legacy?.tuningStatus === 'pending_eval' ? 'warning' : 'secondary'}>{legacy?.tuningStatus || 'idle'}</Badge>
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

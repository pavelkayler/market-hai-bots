import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';
import { useWsClient } from '../../shared/api/ws.js';

function fmt(n, d = 3) { const v = Number(n); return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function fmtTs(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : '—'; }
function fmtPf(v) { return v === Infinity ? '∞' : fmt(v, 3); }

export default function LeadLagPage() {
  const [state, setState] = useState({ status: 'STOPPED' });
  const [rows, setRows] = useState([]);
  const [searchActive, setSearchActive] = useState(false);
  const [sort, setSort] = useState({ key: 'corr', dir: 'desc' });
  const [universe, setUniverse] = useState([]);

  const [settings, setSettings] = useState({ leaderSymbol: 'BTCUSDT', followerSymbol: 'ETHUSDT', leaderMovePct: 1, followerTpPct: 1, followerSlPct: 1, allowShort: true, lagMs: 250 });
  const [autoTuneConfig, setAutoTuneConfig] = useState({ enabled: true, evalWindowTrades: 20, minTradesToStart: 10, minProfitFactor: 1, minExpectancy: 0, tpStepPct: 0.05, tpMinPct: 0.05, tpMaxPct: 0.5 });

  const onMessage = useMemo(() => (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type === 'event' ? msg.topic : msg.type;
    const payload = msg.payload;
    if (type === 'snapshot' && payload?.leadlagState) {
      setState(payload.leadlagState);
      if (payload.leadlagState?.settings) setSettings((prev) => ({ ...prev, ...payload.leadlagState.settings }));
      if (payload.leadlagState?.autoTuneConfig) setAutoTuneConfig((prev) => ({ ...prev, ...payload.leadlagState.autoTuneConfig }));
    }
    if (type === 'leadlag.state') {
      setState((prev) => ({ ...(prev || {}), ...(payload || {}) }));
      if (payload?.settings) setSettings((prev) => ({ ...prev, ...payload.settings }));
      if (payload?.autoTuneConfig) setAutoTuneConfig((prev) => ({ ...prev, ...payload.autoTuneConfig }));
    }
    if (type === 'leadlag.trade') setState((prev) => ({ ...(prev || {}), currentTradeEvents: [payload, ...(prev?.currentTradeEvents || [])].slice(0, 20) }));
    if (type === 'leadlag.settingsUpdated') {
      const nextSettings = payload?.settings || {};
      setSettings((prev) => ({ ...prev, ...nextSettings }));
      setState((prev) => ({ ...(prev || {}), settings: { ...(prev?.settings || {}), ...nextSettings } }));
    }
    if (type === 'leadlag.top' && searchActive) setRows(Array.isArray(payload?.rows) ? payload.rows : (Array.isArray(payload) ? payload : []));
    if (type === 'leadlag.search.ack') setSearchActive(Boolean(payload?.active));
    if (type === 'universe.updated') setUniverse(Array.isArray(payload?.symbols) ? payload.symbols : []);
    if (type === 'leadlag.learningLog') setState((prev) => ({ ...(prev || {}), learningLog: Array.isArray(payload) ? payload : [] }));
  }, [searchActive]);

  const { status, sendJson } = useWsClient({ onOpen: () => { sendJson({ type: 'getLeadLagState' }); sendJson({ type: 'getSnapshot' }); sendJson({ type: 'leadlag.getLearningLog' }); }, onMessage });

  useEffect(() => {
    fetch('/api/universe/list').then((r) => r.json()).then((j) => setUniverse(Array.isArray(j?.symbols) ? j.symbols : [])).catch(() => {});
  }, []);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const factor = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sort.key === 'leader' || sort.key === 'follower') return factor * String(a?.[sort.key] || '').localeCompare(String(b?.[sort.key] || ''));
      return factor * ((Number(a?.[sort.key]) || 0) - (Number(b?.[sort.key]) || 0));
    });
    return list;
  }, [rows, sort]);

  const runSummary = Array.isArray(state?.runSummary) ? state.runSummary : [];
  const positions = Array.isArray(state?.positions) ? state.positions : [];
  const tradeStats = state?.stats || {};
  const learningLog = Array.isArray(state?.learningLog) ? state.learningLog : [];
  const lastEvaluation = state?.lastEvaluation || state?.perConfigLearningState?.lastEvaluation || null;
  const decision = state?.perConfigLearningState?.lastDecision || '—';

  function validSymbol(sym) { return universe.includes(String(sym || '').toUpperCase()); }
  const canStart = validSymbol(settings.leaderSymbol) && validSymbol(settings.followerSymbol);

  return <div className='d-grid gap-3'>
    <Row className='g-3'>
      <Col md={4}><Card><Card.Body className='d-grid gap-2'>
        <div className='d-flex justify-content-between'><strong>LeadLag</strong><Badge bg={status === 'connected' ? 'success' : 'secondary'}>{status}</Badge></div>
        <Form.Group><Form.Label>Leader symbol</Form.Label><Form.Control list='universe-list' value={settings.leaderSymbol} onChange={(e) => setSettings((p) => ({ ...p, leaderSymbol: e.target.value.toUpperCase() }))} /></Form.Group>
        <Form.Group><Form.Label>Follower symbol</Form.Label><Form.Control list='universe-list' value={settings.followerSymbol} onChange={(e) => setSettings((p) => ({ ...p, followerSymbol: e.target.value.toUpperCase() }))} /></Form.Group>
        <datalist id='universe-list'>{universe.map((s) => <option key={s} value={s} />)}</datalist>
        <Form.Group><Form.Label>Leader move trigger (%)</Form.Label><Form.Control type='number' min={0} value={settings.leaderMovePct} onChange={(e) => setSettings((p) => ({ ...p, leaderMovePct: Number(e.target.value) }))} /></Form.Group>
        <Form.Group><Form.Label>Follower TP (%)</Form.Label><Form.Control type='number' min={0} value={settings.followerTpPct} onChange={(e) => setSettings((p) => ({ ...p, followerTpPct: Number(e.target.value), tpSource: 'manual' }))} /></Form.Group>
        <Form.Group><Form.Label>Follower SL (%)</Form.Label><Form.Control type='number' min={0} value={settings.followerSlPct} onChange={(e) => setSettings((p) => ({ ...p, followerSlPct: Number(e.target.value) }))} /></Form.Group>
        <Form.Group><Form.Label>lagMs</Form.Label><Form.Control type='number' min={0} value={settings.lagMs} onChange={(e) => setSettings((p) => ({ ...p, lagMs: Number(e.target.value) }))} /></Form.Group>
        <Form.Check checked={settings.allowShort} onChange={(e) => setSettings((p) => ({ ...p, allowShort: e.target.checked }))} label='allowShort' />
        <div className='small text-muted'>Entry: ${(state?.settings?.entryUsd || 100)} · Leverage: x{state?.settings?.leverage || 10}</div>
        <div className='small text-muted'>TP source: <Badge bg={state?.settings?.tpSource === 'auto' ? 'warning' : 'secondary'}>{state?.settings?.tpSource || 'manual'}</Badge></div>
        <div className='d-flex gap-2'>
          <Button disabled={!canStart} onClick={() => sendJson({ type: 'startLeadLag', settings })}>Start</Button>
          <Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLag' })}>Stop</Button>
          <Button variant='outline-secondary' onClick={() => sendJson({ type: 'resetLeadLag' })}>Reset</Button>
        </div>
        {!canStart ? <div className='small text-danger'>Выберите символы только из universe.</div> : null}
      </Card.Body></Card></Col>

      <Col md={8}><Card><Card.Body>
        <div className='fw-semibold mb-2'>Trading diagnostics</div>
        <div className='small text-muted mb-2'>Trades: {tradeStats.trades || 0} · Wins: {tradeStats.wins || 0} · Losses: {tradeStats.losses || 0} · Win rate: {fmt(tradeStats.winRate, 1)}% · PnL: {fmt(tradeStats.pnlUSDT, 3)} · Fees: {fmt(tradeStats.feesUSDT, 3)} · Funding: {fmt(tradeStats.fundingUSDT, 3)} · Проскальзывание: {fmt(tradeStats.slippageUSDT, 3)} · FeeRate maker: {fmt(tradeStats.feeRateMaker, 4)}</div>
        <div className='fw-semibold'>Positions: {positions.length}/5</div>
        <Table size='sm'><thead><tr><th>Side</th><th>Entry</th><th>Qty</th><th>TP/SL</th><th>Unrealized</th><th>Age</th></tr></thead><tbody>
          {positions.length ? positions.map((p) => <tr key={p.id}><td>{p.side}</td><td>{fmt(p.entryPrice, 4)}</td><td>{fmt(p.qty, 4)}</td><td>{fmt(p.tpPrice, 4)} / {fmt(p.slPrice, 4)}</td><td>{fmt(((state.manual?.followerPrice || 0) - p.entryPrice) * p.qty * (p.side === 'LONG' ? 1 : -1), 4)}</td><td>{fmt((Date.now() - Number(p.openedAt || Date.now())) / 1000, 0)}s</td></tr>) : <tr><td colSpan={6} className='text-muted'>No open positions</td></tr>}
        </tbody></Table>

        <div className='fw-semibold mt-3 mb-2'>Trade events (last 20, current run)</div>
        <Table size='sm'><thead><tr><th>Time</th><th>Event</th><th>Symbol</th><th>Side</th><th>Price</th><th>PnL</th></tr></thead><tbody>
          {(state?.currentTradeEvents || []).length ? state.currentTradeEvents.slice(0, 20).map((t, i) => <tr key={`${t.ts || i}-${i}`}><td>{fmtTs(t.ts)}</td><td>{t.event}</td><td>{t.symbol}</td><td>{t.side}</td><td>{fmt(t.entryPrice || t.exitPrice, 4)}</td><td>{fmt(t.pnlUSDT, 4)}</td></tr>) : <tr><td colSpan={6} className='text-muted'>No trade events</td></tr>}
        </tbody></Table>
      </Card.Body></Card></Col>
    </Row>

    <Card><Card.Body>
      <div className='d-flex gap-2 mb-2'><Button onClick={() => { setSearchActive(true); sendJson({ type: 'startLeadLagSearch' }); }}>Start search</Button><Button variant='outline-danger' onClick={() => sendJson({ type: 'stopLeadLagSearch' })}>Stop search</Button><Badge bg={searchActive ? 'success' : 'secondary'}>{searchActive ? 'ACTIVE' : 'STOPPED'}</Badge></div>
      <div className='fw-semibold mb-2'>Search (top 10, sortable)</div>
      <Table size='sm'><thead><tr><th role='button' onClick={() => setSort((p) => ({ key: 'leader', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Leader</th><th role='button' onClick={() => setSort((p) => ({ key: 'follower', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Follower</th><th role='button' onClick={() => setSort((p) => ({ key: 'corr', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Corr</th><th role='button' onClick={() => setSort((p) => ({ key: 'lagMs', dir: p.dir === 'desc' ? 'asc' : 'desc' }))}>Lag(ms)</th><th>Подтверждения</th></tr></thead><tbody>
        {sortedRows.slice(0, 10).map((r, i) => <tr key={`${r.leader}-${r.follower}-${i}`}><td>{r.leader}</td><td>{r.follower}</td><td>{fmt(r.corr)}</td><td>{fmt(r.lagMs, 0)}</td><td>{Number(r.confirmations || 0)}</td></tr>)}
      </tbody></Table>
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
          <div className='small text-muted'>Только закрытые сделки (CLOSE), single-change rule: меняем только TP.</div>
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

      <div className='small text-muted'>
        Current window quality: PF {fmtPf(lastEvaluation?.profitFactor)} · Expectancy {fmt(lastEvaluation?.expectancy, 4)} · Trades {lastEvaluation?.trades || 0} / Wins {lastEvaluation?.wins || 0} / Losses {lastEvaluation?.losses || 0} · TotalPnL {fmt(lastEvaluation?.totalPnL, 4)} · Decision {decision}
      </div>

      <div className='fw-semibold'>Learning log (last 200)</div>
      <div style={{ maxHeight: 320, overflow: 'auto' }}>
        <Table size='sm' striped hover>
          <thead><tr><th>Time</th><th>Event</th><th>Config</th><th>Metrics</th><th>Change</th><th>Reason</th></tr></thead>
          <tbody>
            {learningLog.length ? learningLog.map((row, idx) => {
              const m = row.metrics || {};
              const ch = row.change || {};
              return <tr key={`${row.ts || idx}-${idx}`}>
                <td>{fmtTs(row.ts)}</td>
                <td>{row.type || '—'}</td>
                <td className='small'>{row.configSummary || row.configKey || '—'}</td>
                <td className='small'>T:{m.trades ?? '—'} PF:{m.profitFactor === Infinity ? '∞' : fmt(m.profitFactor, 2)} Exp:{fmt(m.expectancy, 4)} PnL:{fmt(m.totalPnL, 3)}</td>
                <td className='small'>{ch.paramName ? `${ch.paramName}: ${fmt(ch.from, 4)} → ${fmt(ch.to, 4)} (step ${fmt(ch.step, 4)})` : '—'}</td>
                <td className='small'>{row.reason || '—'}</td>
              </tr>;
            }) : <tr><td colSpan={6} className='text-muted'>No learning events yet</td></tr>}
          </tbody>
        </Table>
      </div>
    </Card.Body></Card>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, ProgressBar, Row } from 'react-bootstrap';
import { useWs } from '../../shared/api/ws.js';

const SIZE_OPTIONS = [50, 100, 200, 500, 1000];
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

export default function UniversePage() {
  const ws = useWs();
  const [targetSizeN, setTargetSizeN] = useState(100);
  const [selectedTierIndex, setSelectedTierIndex] = useState(1);
  const [state, setState] = useState(null);
  const [result, setResult] = useState(null);
  const lastSearchIdRef = useRef(null);

  async function load() {
    const [stRes, outRes] = await Promise.all([
      fetch(`${API_BASE}/api/universe-search/state`).then((r) => r.json()).catch(() => null),
      fetch(`${API_BASE}/api/universe-search/result`).then((r) => r.json()).catch(() => null),
    ]);
    setState(stRes);
    if (outRes && !outRes.error) setResult(outRes);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const unsub = ws.subscribe((_, parsed) => {
      if (parsed?.type !== 'event') return;
      if (parsed.topic === 'universeSearch.state') {
        const next = parsed.payload || null;
        setState(next);
        const nextSearchId = String(next?.searchId || '');
        const prevSearchId = String(lastSearchIdRef.current || '');
        if ((next?.phase === 'FINISHED' || (nextSearchId && nextSearchId !== prevSearchId))) {
          load();
        }
        lastSearchIdRef.current = nextSearchId || prevSearchId;
      }
      if (parsed.topic === 'universeSearch.result') setResult(parsed.payload || null);
    });
    ws.subscribeTopics(['universeSearch.*']);
    return () => { unsub(); ws.unsubscribeTopics(['universeSearch.*']); };
  }, [ws]);

  async function startSearch() {
    setResult(null);
    setSelectedTierIndex(1);
    await fetch(`${API_BASE}/api/universe-search/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetSizeN }) });
    await load();
  }

  async function stopSearch() {
    await fetch(`${API_BASE}/api/universe-search/stop`, { method: 'POST' });
    await load();
  }

  const tiers = result?.outputs?.tiers || [];
  const selectedTier = tiers.find((t) => Number(t.tierIndex) === Number(selectedTierIndex)) || tiers[0] || null;
  const selectedTierSymbols = selectedTier?.symbols || [];
  const tierSizeN = Number(result?.outputs?.tierSizeN || targetSizeN);
  const totalTiers = Number(result?.outputs?.totalTiers || tiers.length || 0);
  const status = String(state?.status || result?.outputs?.status || result?.status || 'IDLE');
  const running = ['STARTING', 'PHASE_A_EXISTS', 'PHASE_B_SPEED', 'STOPPING'].includes(String(state?.phase || '').toUpperCase());
  const pct = useMemo(() => {
    if (!state) return 0;
    if (state.phase === 'PHASE_A_EXISTS') return 40;
    if (state.phase === 'PHASE_B_SPEED') return 80;
    if (state.phase === 'FINISHED') return 100;
    return 10;
  }, [state]);

  return <Row className='g-3'>
    <Col md={12}><Card><Card.Body>
      <Card.Title>Universe Search</Card.Title>
      <div className='d-flex gap-2 align-items-center mb-2'>
        <Form.Select style={{ maxWidth: 180 }} value={targetSizeN} onChange={(e) => setTargetSizeN(Number(e.target.value))}>{SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}</Form.Select>
        <Button onClick={startSearch} disabled={running}>Start Search</Button>
        <Button variant='outline-danger' onClick={stopSearch} disabled={!running}>Stop</Button>
      </div>
      <ProgressBar now={pct} label={state?.phase || 'IDLE'} className='mb-2' />
      <div>searchId: {state?.searchId || result?.searchId || '-'} | Status: {status}</div>
      <div>Tier size N: {tierSizeN} | Total tiers: {totalTiers}</div>
      {!result && <Alert variant='warning' className='mt-2'>No persisted result yet / search in progress.</Alert>}
    </Card.Body></Card></Col>

    <Col md={12}><Card><Card.Body>
      <div className='d-flex gap-2 align-items-center mb-2'>
        <Form.Select style={{ maxWidth: 220 }} value={selectedTierIndex} onChange={(e) => setSelectedTierIndex(Number(e.target.value))}>
          {tiers.map((tier) => <option key={tier.tierIndex} value={tier.tierIndex}>{`Tier ${tier.tierIndex} (${tier.size || tier.symbols?.length || 0})`}</option>)}
          {tiers.length === 0 ? <option value={1}>No tiers yet</option> : null}
        </Form.Select>
        <Badge bg='secondary'>Count: {selectedTierSymbols.length}</Badge>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{selectedTierSymbols.join(', ')}</pre>
    </Card.Body></Card></Col>
  </Row>;
}

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';

import { clearUniverse, createUniverse, killBot, pauseBot, refreshUniverse, resetBotStats, resumeBot, startBot, stopBot } from '../api';
import type { BotSettings, BotState, SymbolUpdatePayload, UniverseState } from '../types';
import { formatDuration } from '../utils/time';

type LogLine = { ts: number; text: string };
type Props = {
  botState: BotState;
  setBotState: React.Dispatch<React.SetStateAction<BotState>>;
  universeState: UniverseState;
  setUniverseState: React.Dispatch<React.SetStateAction<UniverseState>>;
  symbolMap: Record<string, SymbolUpdatePayload>;
  setSymbolMap: React.Dispatch<React.SetStateAction<Record<string, SymbolUpdatePayload>>>;
  logs: LogLine[];
  syncRest: () => Promise<void>;
  symbolUpdatesPerSecond: number;
};

type MinimalSettings = Pick<BotSettings, 'tf' | 'priceUpThrPct' | 'oiUpThrPct' | 'signalCounterMin' | 'signalCounterMax'>;

const SETTINGS_KEY = 'bot.settings.v2';
const defaultSettings: MinimalSettings = { tf: 1, priceUpThrPct: 0.5, oiUpThrPct: 3, signalCounterMin: 2, signalCounterMax: 3 };

function loadSettings(): MinimalSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<MinimalSettings>) };
  } catch {
    return defaultSettings;
  }
}

const toHuman = (ms?: number | null) => {
  if (!ms || !Number.isFinite(ms)) return '—';
  const abs = Math.max(0, ms);
  const min = Math.floor(abs / 60000);
  const sec = Math.floor((abs % 60000) / 1000);
  return `${min}m ${sec}s`;
};

export function BotPage({ botState, universeState, symbolMap, syncRest, symbolUpdatesPerSecond }: Props) {
  const [settings, setSettings] = useState<MinimalSettings>(loadSettings());
  const [minVolPct, setMinVolPct] = useState(10);
  const [minTurnover, setMinTurnover] = useState(10_000_000);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const symbolRows = useMemo(() => {
    const contractSymbols = botState.symbols ?? [];
    if (contractSymbols.length > 0) {
      return contractSymbols.map((row) => ({
        symbol: row.symbol,
        markPrice: Number.isFinite(row.markPrice) ? row.markPrice : null,
        openInterestValue: Number.isFinite(row.openInterestValue) ? row.openInterestValue : null,
        priceDeltaPct: Number.isFinite(row.priceDeltaPct) ? row.priceDeltaPct : 0,
        oiDeltaPct: Number.isFinite(row.oiDeltaPct) ? row.oiDeltaPct : 0,
        fundingRate: row.fundingRate,
        nextFundingTimeMs: row.nextFundingTimeMs,
        timeToFundingMs: row.timeToFundingMs,
        tradability: row.tradability,
        signalCount24h: row.signalCount24h,
        lastSignalAtMs: row.lastSignalAtMs,
        blackoutReason: row.blackoutReason ?? null
      }));
    }

    const diagnostics = botState.activeSymbolDiagnostics ?? [];
    return diagnostics.map((diag) => {
      const ws = symbolMap[diag.symbol];
      return {
        symbol: diag.symbol,
        markPrice: ws?.markPrice ?? null,
        openInterestValue: ws?.openInterestValue ?? null,
        priceDeltaPct: 0,
        oiDeltaPct: 0,
        fundingRate: diag.fundingRate ?? null,
        nextFundingTimeMs: diag.nextFundingTimeMs ?? null,
        timeToFundingMs: diag.timeToFundingMs ?? null,
        tradability: diag.tradingAllowed ?? 'MISSING',
        signalCount24h: diag.signalCount24h ?? 0,
        lastSignalAtMs: diag.lastSignalAt ?? null,
        blackoutReason: null
      };
    });
  }, [botState.symbols, botState.activeSymbolDiagnostics, symbolMap]);

  const onStart = async () => {
    setError('');
    setStatus('');
    try {
      await startBot({
        tf: settings.tf,
        priceUpThrPct: settings.priceUpThrPct,
        oiUpThrPct: settings.oiUpThrPct,
        signalCounterMin: settings.signalCounterMin,
        signalCounterMax: settings.signalCounterMax,
        minTriggerCount: settings.signalCounterMin,
        maxTriggerCount: settings.signalCounterMax
      } as unknown as BotSettings);
      setStatus('Bot started');
      await syncRest();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="d-grid gap-3">
      {status ? <Alert variant="success">{status}</Alert> : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}

      <Card><Card.Body>
        <Row className="g-2">
          <Col md={8}><strong>Lifecycle:</strong> {botState.running ? (botState.paused ? 'PAUSED' : 'RUNNING') : 'STOPPED'} · uptime {formatDuration(botState.uptimeMs)}</Col>
          <Col md={4} className="text-md-end"><strong>Symbol updates/sec:</strong> {symbolUpdatesPerSecond}</Col>
        </Row>
        <div className="mt-2 d-flex gap-2 flex-wrap">
          <Button size="sm" onClick={() => void onStart()} disabled={botState.running}>Start</Button>
          <Button size="sm" variant="outline-secondary" onClick={() => void pauseBot().then(syncRest)}>Pause</Button>
          <Button size="sm" variant="outline-secondary" onClick={() => void resumeBot().then(syncRest)}>Resume</Button>
          <Button size="sm" variant="outline-warning" onClick={() => void stopBot().then(syncRest)}>Stop</Button>
          <Button size="sm" variant="danger" onClick={() => void killBot().then(syncRest)}>KILL</Button>
          <Button size="sm" variant="outline-dark" onClick={() => void resetBotStats().then(syncRest)}>Reset Stats</Button>
        </div>
      </Card.Body></Card>

      <Card><Card.Body>
        <Card.Title>Universe</Card.Title>
        <Row className="g-2 align-items-end">
          <Col md={3}><Form.Label>Min Vol %</Form.Label><Form.Control type="number" value={minVolPct} onChange={(e) => setMinVolPct(Number(e.target.value))} /></Col>
          <Col md={3}><Form.Label>Min Turnover</Form.Label><Form.Control type="number" value={minTurnover} onChange={(e) => setMinTurnover(Number(e.target.value))} /></Col>
          <Col md="auto"><Button size="sm" onClick={() => void createUniverse(minVolPct, minTurnover).then(syncRest)}>Create</Button></Col>
          <Col md="auto"><Button size="sm" variant="outline-primary" onClick={() => void refreshUniverse({ minVolPct, minTurnover }).then(syncRest)}>Refresh</Button></Col>
          <Col md="auto"><Button size="sm" variant="outline-danger" onClick={() => void clearUniverse().then(syncRest)}>Clear</Button></Col>
        </Row>
        <div className="small mt-2">Ready: <Badge bg={universeState.ready ? 'success' : 'secondary'}>{String(universeState.ready)}</Badge> · Symbols: {universeState.symbols?.length ?? 0}</div>
      </Card.Body></Card>

      <Card><Card.Body>
        <Card.Title>Settings (v2)</Card.Title>
        <Row className="g-2">
          <Col md={2}><Form.Label>TF</Form.Label><Form.Select value={settings.tf} onChange={(e) => setSettings((s) => ({ ...s, tf: Number(e.target.value) as MinimalSettings['tf'] }))}>{[1,3,5,10,15].map((v)=><option key={v} value={v}>{v}m</option>)}</Form.Select></Col>
          <Col md={2}><Form.Label>priceUpThrPct</Form.Label><Form.Control type="number" value={settings.priceUpThrPct} onChange={(e) => setSettings((s) => ({ ...s, priceUpThrPct: Number(e.target.value) }))} /></Col>
          <Col md={2}><Form.Label>oiUpThrPct</Form.Label><Form.Control type="number" value={settings.oiUpThrPct} onChange={(e) => setSettings((s) => ({ ...s, oiUpThrPct: Number(e.target.value) }))} /></Col>
          <Col md={2}><Form.Label>minTriggerCount</Form.Label><Form.Control type="number" value={settings.signalCounterMin} onChange={(e) => setSettings((s) => ({ ...s, signalCounterMin: Number(e.target.value) }))} /></Col>
          <Col md={2}><Form.Label>maxTriggerCount</Form.Label><Form.Control type="number" value={settings.signalCounterMax} onChange={(e) => setSettings((s) => ({ ...s, signalCounterMax: Number(e.target.value) }))} /></Col>
        </Row>
        <div className="small text-muted mt-2">Percent convention: 3 means 3%.</div>
      </Card.Body></Card>

      <Card><Card.Body>
        <Card.Title>Active symbols</Card.Title>
        <Table size="sm" striped responsive>
          <thead><tr><th>Symbol</th><th>Mark</th><th>OIV</th><th>ΔPrice%</th><th>ΔOIV%</th><th>Funding</th><th>Next funding (ETA)</th><th>Tradability</th><th>SignalCount</th><th>LastSignal</th></tr></thead>
          <tbody>
            {symbolRows.map((row) => (
              <tr key={row.symbol}>
                <td>{row.symbol}</td>
                <td className="font-monospace">{row.markPrice ?? '—'}</td>
                <td className="font-monospace">{row.openInterestValue ?? '—'}</td>
                <td className="font-monospace">{row.priceDeltaPct.toFixed(3)}</td>
                <td className="font-monospace">{row.oiDeltaPct.toFixed(3)}</td>
                <td className="font-monospace">{row.fundingRate == null ? <Badge bg="danger">MISSING</Badge> : row.fundingRate}</td>
                <td className="font-monospace">{row.nextFundingTimeMs ? `${new Date(row.nextFundingTimeMs).toLocaleString()} (${toHuman(row.timeToFundingMs)})` : '—'}</td>
                <td><Badge bg={row.tradability === 'OK' ? 'success' : row.tradability === 'MISSING' ? 'danger' : 'warning'}>{row.tradability}</Badge></td>
                <td className="font-monospace">{row.signalCount24h}</td>
                <td className="font-monospace">{row.lastSignalAtMs ? new Date(row.lastSignalAtMs).toLocaleTimeString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card.Body></Card>
    </div>
  );
}

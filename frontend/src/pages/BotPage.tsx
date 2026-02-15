import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from 'react-bootstrap';

import { ApiRequestError, cancelOrder, clearUniverse, createUniverse, getBotState, getUniverse, pauseBot, refreshUniverse, resumeBot, startBot, stopBot } from '../api';
import type { BotSettings, BotState, SymbolUpdatePayload, UniverseState } from '../types';

type LogLine = {
  ts: number;
  text: string;
};

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

const SETTINGS_KEY = 'bot.settings.v1';

const defaultSettings: BotSettings = {
  mode: 'paper',
  direction: 'both',
  tf: 1,
  holdSeconds: 3,
  priceUpThrPct: 0.5,
  oiUpThrPct: 50,
  marginUSDT: 100,
  leverage: 10,
  tpRoiPct: 1,
  slRoiPct: 0.7
};

function loadSettings(): BotSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return defaultSettings;
    }

    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<BotSettings>) };
  } catch {
    return defaultSettings;
  }
}

function formatSecondsLeft(expiresTs: number): string {
  const sec = Math.max(0, Math.floor((expiresTs - Date.now()) / 1000));
  return `${sec}s`;
}

export function BotPage({
  botState,
  setBotState,
  universeState,
  setUniverseState,
  symbolMap,
  setSymbolMap,
  logs,
  syncRest,
  symbolUpdatesPerSecond
}: Props) {
  const [minVolPct, setMinVolPct] = useState<number>(10);
  const [settings, setSettings] = useState<BotSettings>(loadSettings());
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!botState.lastConfig) {
      return;
    }

    persistSettings(botState.lastConfig);
  }, [botState.lastConfig]);

  const trackedSymbols = useMemo(() => {
    return Object.values(symbolMap).filter((item) => item.state !== 'IDLE' || item.pendingOrder || item.position);
  }, [symbolMap]);

  const persistSettings = (next: BotSettings) => {
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  };

  const handleUniverseAction = async (action: 'create' | 'refresh' | 'get' | 'clear') => {
    setError('');
    try {
      if (action === 'create') {
        await createUniverse(minVolPct);
      } else if (action === 'refresh') {
        await refreshUniverse(minVolPct);
      } else if (action === 'get') {
        const data = await getUniverse();
        setUniverseState(data);
      } else {
        await clearUniverse();
        setUniverseState({ ok: true, ready: false });
        setSymbolMap({});
      }

      await syncRest();
      setStatus(`Universe ${action} ok`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStart = async () => {
    setError('');
    try {
      await startBot(settings);
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleStop = async () => {
    setError('');
    try {
      await stopBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot stopped');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handlePause = async () => {
    setError('');
    try {
      await pauseBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot paused');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleResume = async () => {
    setError('');
    try {
      await resumeBot();
      const next = await getBotState();
      setBotState(next);
      setStatus('Bot resumed');
    } catch (err) {
      const apiError = err as ApiRequestError;
      if (apiError.code === 'NO_SNAPSHOT') {
        setError('Snapshot not found. Start a new session or wait for a snapshot to be saved.');
        return;
      }
      setError(apiError.message);
    }
  };

  const disableSettings = botState.running;

  return (
    <Row className="g-3">
      <Col md={6}>
        <Card>
          <Card.Header>Universe</Card.Header>
          <Card.Body>
            <Form.Group className="mb-3">
              <Form.Label>minVolPct</Form.Label>
              <Form.Control type="number" value={minVolPct} onChange={(event) => setMinVolPct(Number(event.target.value))} />
            </Form.Group>
            <div className="d-flex gap-2 flex-wrap mb-3">
              <Button onClick={() => void handleUniverseAction('create')}>Create</Button>
              <Button variant="secondary" onClick={() => void handleUniverseAction('refresh')}>
                Refresh
              </Button>
              <Button variant="outline-primary" onClick={() => void handleUniverseAction('get')}>
                Get
              </Button>
              <Button variant="outline-danger" onClick={() => void handleUniverseAction('clear')}>
                Clear
              </Button>
            </div>
            <div>
              <div>Ready: {String(universeState.ready)}</div>
              <div>Created At: {universeState.createdAt ? new Date(universeState.createdAt).toLocaleString() : '-'}</div>
              <div>Filters: {universeState.filters ? JSON.stringify(universeState.filters) : '-'}</div>
              <div>Symbols: {universeState.symbols?.length ?? 0}</div>
            </div>
          </Card.Body>
        </Card>
      </Col>

      <Col md={6}>
        <Card>
          <Card.Header>Settings</Card.Header>
          <Card.Body>
            {disableSettings ? <Alert variant="warning">Settings are locked while the bot is running.</Alert> : null}
            <Row className="g-2">
              <Col>
                <Form.Label>Mode</Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.mode}
                  onChange={(event) => persistSettings({ ...settings, mode: event.target.value as BotSettings['mode'] })}
                >
                  <option value="paper">paper</option>
                  <option value="demo">demo</option>
                </Form.Select>
              </Col>
              <Col>
                <Form.Label>Direction</Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.direction}
                  onChange={(event) => persistSettings({ ...settings, direction: event.target.value as BotSettings['direction'] })}
                >
                  <option value="long">long</option>
                  <option value="short">short</option>
                  <option value="both">both</option>
                </Form.Select>
              </Col>
              <Col>
                <Form.Label>TF</Form.Label>
                <Form.Select
                  disabled={disableSettings}
                  value={settings.tf}
                  onChange={(event) => persistSettings({ ...settings, tf: Number(event.target.value) as 1 | 3 | 5 })}
                >
                  <option value="1">1</option>
                  <option value="3">3</option>
                  <option value="5">5</option>
                </Form.Select>
              </Col>
            </Row>
            <Row className="g-2 mt-1">
              {(
                [
                  ['holdSeconds', 'holdSeconds'],
                  ['priceUpThrPct', 'priceUpThrPct'],
                  ['oiUpThrPct', 'oiUpThrPct'],
                  ['marginUSDT', 'marginUSDT'],
                  ['leverage', 'leverage'],
                  ['tpRoiPct', 'tpRoiPct'],
                  ['slRoiPct', 'slRoiPct']
                ] as const
              ).map(([label, key]) => (
                <Col md={4} key={key}>
                  <Form.Label>{label}</Form.Label>
                  <Form.Control
                    disabled={disableSettings}
                    type="number"
                    value={settings[key]}
                    onChange={(event) => persistSettings({ ...settings, [key]: Number(event.target.value) })}
                  />
                </Col>
              ))}
            </Row>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Controls</Card.Header>
          <Card.Body>
            <div className="d-flex gap-2 mb-3">
              <Button variant="success" onClick={() => void handleStart()} disabled={botState.running}>
                Start
              </Button>
              <Button variant="warning" onClick={() => void handlePause()} disabled={!botState.running || botState.paused}>
                Pause
              </Button>
              <Button variant="info" onClick={() => void handleResume()} disabled={!botState.hasSnapshot && !botState.paused}>
                Resume
              </Button>
              <Button variant="danger" onClick={() => void handleStop()} disabled={!botState.running}>
                Stop
              </Button>
            </div>
            <Card className="mb-3">
              <Card.Header>Session</Card.Header>
              <Card.Body>
                <div className="mb-2">
                  Snapshot:{' '}
                  <Badge bg={botState.hasSnapshot ? 'success' : 'secondary'}>{botState.hasSnapshot ? 'hasSnapshot=true' : 'none'}</Badge>
                </div>
                {botState.hasSnapshot && !botState.running ? (
                  <Alert variant="info" className="mt-2 mb-0">
                    Snapshot found. Click Resume to continue monitoring/orders.
                  </Alert>
                ) : null}
              </Card.Body>
            </Card>
            <Badge bg="info" className="me-2">
              queueDepth: {botState.queueDepth}
            </Badge>
            <Badge bg="secondary" className="me-2">
              activeOrders: {botState.activeOrders}
            </Badge>
            <Badge bg="dark" className="me-2">openPositions: {botState.openPositions}</Badge>
            <Badge bg="primary" className="me-2">universeSymbols: {universeState.symbols?.length ?? 0}</Badge>
            <Badge bg="light" text="dark">symbolUpdates/s: {symbolUpdatesPerSecond}</Badge>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Orders / Positions</Card.Header>
          <Card.Body className="table-responsive">
            <Table bordered striped size="sm">
              <thead>
                <tr>
                  <th>symbol</th>
                  <th>state</th>
                  <th>markPrice</th>
                  <th>openInterestValue</th>
                  <th>baseline</th>
                  <th>pendingOrder</th>
                  <th>position</th>
                  <th>action</th>
                </tr>
              </thead>
              <tbody>
                {trackedSymbols.map((item) => (
                  <tr key={item.symbol}>
                    <td>{item.symbol}</td>
                    <td>{item.state}</td>
                    <td>{item.markPrice}</td>
                    <td>{item.openInterestValue}</td>
                    <td>{item.baseline ? `${item.baseline.basePrice} / ${item.baseline.baseOiValue}` : '-'}</td>
                    <td>
                      {item.pendingOrder
                        ? `${item.pendingOrder.side} @${item.pendingOrder.limitPrice}, qty ${item.pendingOrder.qty}, expires ${formatSecondsLeft(item.pendingOrder.expiresTs)}`
                        : '-'}
                    </td>
                    <td>
                      {item.position
                        ? `${item.position.side} entry ${item.position.entryPrice}, tp ${item.position.tpPrice}, sl ${item.position.slPrice}, qty ${item.position.qty}`
                        : '-'}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        disabled={!item.pendingOrder}
                        onClick={() => {
                          void cancelOrder(item.symbol).then(() => syncRest());
                        }}
                      >
                        Cancel
                      </Button>
                    </td>
                  </tr>
                ))}
                {trackedSymbols.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center">
                      No active symbols
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>

      <Col md={12}>
        <Card>
          <Card.Header>Log (last 5)</Card.Header>
          <Card.Body>
            {logs.length === 0 ? <div>No logs yet.</div> : null}
            {logs.map((line) => (
              <div key={`${line.ts}-${line.text}`}>{`${new Date(line.ts).toLocaleTimeString()} - ${line.text}`}</div>
            ))}
          </Card.Body>
        </Card>
      </Col>

      {status ? <Alert variant="success">{status}</Alert> : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}
    </Row>
  );
}

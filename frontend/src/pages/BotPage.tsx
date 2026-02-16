import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Collapse, Form, Row, Table } from 'react-bootstrap';

import {
  ApiRequestError,
  cancelOrder,
  clearJournal,
  clearUniverse,
  createUniverse,
  downloadJournal,
  downloadUniverseJson,
  getBotState,
  getJournalTail,
  getReplayFiles,
  getReplayState,
  getUniverse,
  pauseBot,
  refreshUniverse,
  resumeBot,
  startBot,
  startRecording,
  startReplay,
  stopBot,
  stopRecording,
  stopReplay
} from '../api';
import type { BotSettings, BotState, JournalEntry, ReplaySpeed, ReplayState, SymbolUpdatePayload, UniverseState } from '../types';

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


type ActiveSymbolRowProps = {
  item: SymbolUpdatePayload;
  onCancel: (symbol: string) => void;
};

const ActiveSymbolRow = memo(function ActiveSymbolRow({ item, onCancel }: ActiveSymbolRowProps) {
  return (
    <tr>
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
        <Button size="sm" variant="outline-danger" disabled={!item.pendingOrder} onClick={() => onCancel(item.symbol)}>
          Cancel
        </Button>
      </td>
    </tr>
  );
});

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
  const [showUniverseSymbols, setShowUniverseSymbols] = useState<boolean>(false);
  const [universeSearch, setUniverseSearch] = useState<string>('');
  const [universeSort, setUniverseSort] = useState<'turnover' | 'symbol'>('turnover');
  const [universePage, setUniversePage] = useState<number>(1);
  const [recordTopN, setRecordTopN] = useState<number>(20);
  const [recordFileName, setRecordFileName] = useState<string>(`session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson`);
  const [replayFileName, setReplayFileName] = useState<string>('');
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>('1x');
  const [replayState, setReplayState] = useState<ReplayState>({
    recording: false,
    replaying: false,
    fileName: null,
    speed: null,
    recordsWritten: 0,
    progress: { read: 0, total: 0 }
  });
  const [replayFiles, setReplayFiles] = useState<string[]>([]);
  const [journalLimit, setJournalLimit] = useState<number>(200);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);

  useEffect(() => {
    if (!botState.lastConfig) {
      return;
    }

    persistSettings(botState.lastConfig);
  }, [botState.lastConfig]);

  const trackedSymbols = useMemo(() => {
    return Object.values(symbolMap).filter((item) => item.state !== 'IDLE' || item.pendingOrder || item.position);
  }, [symbolMap]);

  const handleCancelOrder = useCallback(
    (symbol: string) => {
      void cancelOrder(symbol).then(() => syncRest());
    },
    [syncRest]
  );

  const filteredUniverseSymbols = useMemo(() => {
    const symbols = [...(universeState.symbols ?? [])];
    const query = universeSearch.trim().toLowerCase();
    const searched = query.length === 0 ? symbols : symbols.filter((entry) => entry.symbol.toLowerCase().includes(query));

    if (universeSort === 'symbol') {
      return searched.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    return searched.sort((a, b) => b.turnover24h - a.turnover24h);
  }, [universeSearch, universeSort, universeState.symbols]);

  const pageSize = 50;
  const universePageCount = Math.max(1, Math.ceil(filteredUniverseSymbols.length / pageSize));
  const currentUniversePage = Math.min(universePage, universePageCount);
  const paginatedUniverseSymbols = useMemo(() => {
    const start = (currentUniversePage - 1) * pageSize;
    return filteredUniverseSymbols.slice(start, start + pageSize);
  }, [currentUniversePage, filteredUniverseSymbols]);

  useEffect(() => {
    setUniversePage(1);
  }, [universeSearch, universeSort, universeState.symbols]);

  useEffect(() => {
    const refreshReplayState = async () => {
      try {
        const [state, filesResponse] = await Promise.all([getReplayState(), getReplayFiles()]);
        setReplayState(state);
        setReplayFiles(filesResponse.files);
      } catch {
        // no-op: optional card state
      }
    };

    void refreshReplayState();
    const interval = window.setInterval(() => {
      void refreshReplayState();
    }, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

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

  const handleDownloadUniverseJson = async () => {
    setError('');
    try {
      const blob = await downloadUniverseJson();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'universe.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus('Universe download started');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCopySymbols = async () => {
    const value = (universeState.symbols ?? []).map((entry) => entry.symbol).join('\n');
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Universe symbols copied');
    } catch {
      alert('Clipboard unavailable in this browser/session.');
    }
  };

  const handleRecordStart = async () => {
    setError('');
    try {
      await startRecording(recordTopN, recordFileName);
      setStatus('Recording started');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRecordStop = async () => {
    setError('');
    try {
      await stopRecording();
      setStatus('Recording stopped');
      setReplayState(await getReplayState());
      const files = await getReplayFiles();
      setReplayFiles(files.files);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReplayStart = async () => {
    setError('');
    try {
      await startReplay(replayFileName, replaySpeed);
      setStatus('Replay started');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleReplayStop = async () => {
    setError('');
    try {
      await stopReplay();
      setStatus('Replay stopped');
      setReplayState(await getReplayState());
    } catch (err) {
      setError((err as Error).message);
    }
  };


  const refreshJournal = async (limit: number = journalLimit) => {
    const response = await getJournalTail(limit);
    setJournalEntries(response.entries);
  };

  useEffect(() => {
    void refreshJournal();
    const interval = window.setInterval(() => {
      void refreshJournal();
    }, 8000);

    return () => {
      window.clearInterval(interval);
    };
  }, [journalLimit]);

  const handleClearJournal = async () => {
    if (!window.confirm('Clear journal entries? This cannot be undone.')) {
      return;
    }

    setError('');
    try {
      await clearJournal();
      await refreshJournal();
      setStatus('Journal cleared');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDownloadJournal = async (format: 'ndjson' | 'json' | 'csv') => {
    setError('');
    try {
      const blob = await downloadJournal(format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `journal.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setStatus(`Journal ${format.toUpperCase()} download started`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const formatJournalSummary = (entry: JournalEntry): string => {
    const qty = typeof entry.data.qty === 'number' ? `qty ${entry.data.qty}` : null;
    const price =
      typeof entry.data.limitPrice === 'number'
        ? `limit ${entry.data.limitPrice}`
        : typeof entry.data.entryPrice === 'number'
          ? `entry ${entry.data.entryPrice}`
          : typeof entry.data.markPrice === 'number'
            ? `mark ${entry.data.markPrice}`
            : null;
    const pnl = typeof entry.data.pnlUSDT === 'number' ? `pnl ${entry.data.pnlUSDT.toFixed(4)}` : null;
    return [qty, price, pnl].filter(Boolean).join(', ') || '-';
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

            <div className="d-flex gap-2 flex-wrap mt-3">
              <Button variant="outline-primary" onClick={() => setShowUniverseSymbols((value) => !value)}>
                Universe Symbols
              </Button>
              <Button variant="outline-success" onClick={() => void handleDownloadUniverseJson()}>
                Download universe.json
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleCopySymbols()}>
                Copy symbols
              </Button>
            </div>

            <Collapse in={showUniverseSymbols}>
              <div className="mt-3">
                {!universeState.ready ? <Alert variant="warning">Universe is not ready. Create it first.</Alert> : null}
                <Row className="g-2 mb-2">
                  <Col md={8}>
                    <Form.Control
                      placeholder="Search symbol"
                      value={universeSearch}
                      onChange={(event) => setUniverseSearch(event.target.value)}
                    />
                  </Col>
                  <Col md={4}>
                    <Form.Select
                      value={universeSort}
                      onChange={(event) => setUniverseSort(event.target.value as 'turnover' | 'symbol')}
                    >
                      <option value="turnover">Sort: turnover24h desc</option>
                      <option value="symbol">Sort: symbol A-Z</option>
                    </Form.Select>
                  </Col>
                </Row>
                <Table bordered striped size="sm" className="mb-2">
                  <thead>
                    <tr>
                      <th>symbol</th>
                      <th>turnover24h</th>
                      <th>vol24hPct</th>
                      <th>forcedActive</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedUniverseSymbols.map((entry) => (
                      <tr key={entry.symbol}>
                        <td>{entry.symbol}</td>
                        <td>{entry.turnover24h.toLocaleString()}</td>
                        <td>{entry.vol24hPct.toFixed(2)}%</td>
                        <td>{entry.forcedActive ? <Badge bg="warning" text="dark">forced</Badge> : <Badge bg="secondary">no</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <div className="d-flex align-items-center justify-content-between">
                  <small>
                    Page {currentUniversePage}/{universePageCount} ({filteredUniverseSymbols.length} symbols)
                  </small>
                  <div className="d-flex gap-2">
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={currentUniversePage <= 1}
                      onClick={() => setUniversePage((value) => Math.max(1, value - 1))}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={currentUniversePage >= universePageCount}
                      onClick={() => setUniversePage((value) => Math.min(universePageCount, value + 1))}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </div>
            </Collapse>
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
          <Card.Header>Replay</Card.Header>
          <Card.Body>
            <Row className="g-3">
              <Col md={6}>
                <Card>
                  <Card.Header>Recording</Card.Header>
                  <Card.Body>
                    <Form.Group className="mb-2">
                      <Form.Label>Top N symbols by turnover</Form.Label>
                      <Form.Control type="number" value={recordTopN} onChange={(event) => setRecordTopN(Number(event.target.value))} />
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>File name (.ndjson)</Form.Label>
                      <Form.Control value={recordFileName} onChange={(event) => setRecordFileName(event.target.value)} />
                    </Form.Group>
                    <div className="d-flex gap-2">
                      <Button variant="success" onClick={() => void handleRecordStart()} disabled={replayState.recording || replayState.replaying}>
                        Start recording
                      </Button>
                      <Button variant="danger" onClick={() => void handleRecordStop()} disabled={!replayState.recording}>
                        Stop recording
                      </Button>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
              <Col md={6}>
                <Card>
                  <Card.Header>Replay run</Card.Header>
                  <Card.Body>
                    <Form.Group className="mb-2">
                      <Form.Label>Recorded file</Form.Label>
                      <Form.Select value={replayFileName} onChange={(event) => setReplayFileName(event.target.value)}>
                        <option value="">Select file</option>
                        {replayFiles.map((file) => (
                          <option key={file} value={file}>
                            {file}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>Or type file name</Form.Label>
                      <Form.Control value={replayFileName} onChange={(event) => setReplayFileName(event.target.value)} />
                    </Form.Group>
                    <Form.Group className="mb-2">
                      <Form.Label>Speed</Form.Label>
                      <Form.Select value={replaySpeed} onChange={(event) => setReplaySpeed(event.target.value as ReplaySpeed)}>
                        <option value="1x">1x</option>
                        <option value="5x">5x</option>
                        <option value="20x">20x</option>
                        <option value="fast">fast</option>
                      </Form.Select>
                    </Form.Group>
                    <div className="d-flex gap-2">
                      <Button variant="primary" onClick={() => void handleReplayStart()} disabled={replayState.recording || replayState.replaying || replayFileName.length === 0}>
                        Start replay
                      </Button>
                      <Button variant="outline-danger" onClick={() => void handleReplayStop()} disabled={!replayState.replaying}>
                        Stop replay
                      </Button>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            </Row>
            <div className="mt-3">
              <Badge bg={replayState.recording ? 'success' : 'secondary'} className="me-2">
                recording: {replayState.recording ? 'on' : 'off'}
              </Badge>
              <Badge bg={replayState.replaying ? 'warning' : 'secondary'} className="me-2">
                replaying: {replayState.replaying ? 'on' : 'off'}
              </Badge>
              <Badge bg="info" className="me-2">
                file: {replayState.fileName ?? '-'}
              </Badge>
              <Badge bg="dark" className="me-2">
                speed: {replayState.speed ?? '-'}
              </Badge>
              <Badge bg="primary" className="me-2">
                recordsWritten: {replayState.recordsWritten}
              </Badge>
              <Badge bg="light" text="dark">
                progress: {replayState.progress.read}/{replayState.progress.total}
              </Badge>
            </div>
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
                  <ActiveSymbolRow key={item.symbol} item={item} onCancel={handleCancelOrder} />
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
          <Card.Header>Journal</Card.Header>
          <Card.Body>
            <div className="d-flex flex-wrap gap-2 align-items-end mb-3">
              <Form.Group>
                <Form.Label>Limit</Form.Label>
                <Form.Select value={journalLimit} onChange={(event) => setJournalLimit(Number(event.target.value))}>
                  <option value={50}>50</option>
                  <option value={200}>200</option>
                  <option value={1000}>1000</option>
                </Form.Select>
              </Form.Group>
              <Button variant="outline-primary" onClick={() => void refreshJournal()}>
                Refresh
              </Button>
              <Button variant="outline-danger" onClick={() => void handleClearJournal()}>
                Clear
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('ndjson')}>
                NDJSON
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('json')}>
                JSON
              </Button>
              <Button variant="outline-secondary" onClick={() => void handleDownloadJournal('csv')}>
                CSV
              </Button>
            </div>
            <div className="table-responsive">
              <Table bordered striped size="sm">
                <thead>
                  <tr>
                    <th>ts</th>
                    <th>mode</th>
                    <th>symbol</th>
                    <th>event</th>
                    <th>side</th>
                    <th>summary</th>
                  </tr>
                </thead>
                <tbody>
                  {journalEntries.map((entry) => (
                    <tr key={`${entry.ts}-${entry.symbol}-${entry.event}-${JSON.stringify(entry.data)}`}>
                      <td>{new Date(entry.ts).toLocaleString()}</td>
                      <td>{entry.mode}</td>
                      <td>{entry.symbol}</td>
                      <td>{entry.event}</td>
                      <td>{entry.side ?? '-'}</td>
                      <td>{formatJournalSummary(entry)}</td>
                    </tr>
                  ))}
                  {journalEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center">
                        No journal entries
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </Table>
            </div>
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

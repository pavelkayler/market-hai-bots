import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Form, Row, Tab, Table, Tabs } from 'react-bootstrap';

import { clearUniverse, createUniverse, getBotState, getBotStats, killBot, pauseBot, refreshUniverse, resetBot, startBot, stopBot } from '../api';
import { useSort } from '../hooks/useSort';
import type { BotSettings, BotState, BotStats, BotPerSymbolStats, SymbolUpdatePayload, UniverseState } from '../types';
import { formatDuration } from '../utils/time';

type LogLine = { ts: number; text: string };
type Props = {
  botState: BotState;
  universeState: UniverseState;
  symbolMap: Record<string, SymbolUpdatePayload>;
  logs: LogLine[];
  syncRest: () => Promise<void>;
  symbolUpdatesPerSecond: number;
};

type MinimalSettings = Pick<BotSettings, 'tf' | 'priceUpThrPct' | 'oiUpThrPct' | 'minFundingAbs' | 'signalCounterMin' | 'signalCounterMax'>;

type PerSymbolResultsRow = {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winrate: number;
  longs: number;
  shorts: number;
  pnlUSDT: number | null;
  avgWinUSDT: number | null;
  avgLossUSDT: number | null;
  lastTradeAt: number | null;
};

type ActiveSymbolRow = {
  symbol: string;
  markPrice: number | null;
  openInterestValue: number | null;
  priceDeltaPct: number | null;
  oiDeltaPct: number | null;
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  timeToFundingMs: number | null;
  fundingAgeMs: number | null;
  fundingStatus: 'OK' | 'MISSING' | 'STALE';
  tradability: 'OK' | 'BLACKOUT' | 'COOLDOWN' | 'MISSING';
  signalCount24h: number;
  lastSignalAtMs: number | null;
  blackoutReason: string | null;
  topReason: string | null;
};

const SETTINGS_KEY = 'bot.settings.v2';
const defaultSettings: MinimalSettings = { tf: 1, priceUpThrPct: 0.5, oiUpThrPct: 3, minFundingAbs: 0, signalCounterMin: 2, signalCounterMax: 3 };

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

function toPerSymbolRows(stats: BotStats | null): PerSymbolResultsRow[] {
  const perSymbol = stats?.perSymbol ?? [];
  return perSymbol.map((row: BotPerSymbolStats) => ({
    symbol: row.symbol,
    trades: row.trades,
    wins: row.wins,
    losses: row.losses,
    winrate: Number.isFinite(row.winratePct) ? row.winratePct : row.trades > 0 ? (row.wins / row.trades) * 100 : 0,
    longs: row.longTrades,
    shorts: row.shortTrades,
    pnlUSDT: Number.isFinite(row.pnlUSDT) ? row.pnlUSDT : null,
    avgWinUSDT: row.avgWinUSDT ?? null,
    avgLossUSDT: row.avgLossUSDT ?? null,
    lastTradeAt: row.lastClosedTs ?? null
  }));
}

export function BotPage({ botState, universeState, symbolMap, syncRest, symbolUpdatesPerSecond }: Props) {
  const [settings, setSettings] = useState<MinimalSettings>(loadSettings());
  const [minVolPct, setMinVolPct] = useState(10);
  const [minTurnover, setMinTurnover] = useState(10_000_000);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState<BotStats | null>(null);
  const [cachedBotState, setCachedBotState] = useState<BotState>(botState);
  const refreshInFlight = useRef(false);

  useEffect(() => {
    setCachedBotState(botState);
  }, [botState]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);


  useEffect(() => {
    if (!botState.lastConfig) {
      return;
    }

    setSettings((prev) => ({
      ...prev,
      tf: botState.lastConfig?.tf ?? prev.tf,
      priceUpThrPct: botState.lastConfig?.priceUpThrPct ?? prev.priceUpThrPct,
      oiUpThrPct: botState.lastConfig?.oiUpThrPct ?? prev.oiUpThrPct,
      minFundingAbs: botState.lastConfig?.minFundingAbs ?? prev.minFundingAbs ?? 0,
      signalCounterMin: botState.lastConfig?.signalCounterMin ?? prev.signalCounterMin,
      signalCounterMax: botState.lastConfig?.signalCounterMax ?? prev.signalCounterMax
    }));
  }, [botState.lastConfig]);

  const refreshBotData = useCallback(async (signal?: AbortSignal) => {
    if (refreshInFlight.current) {
      return;
    }

    refreshInFlight.current = true;
    try {
      const [nextState, statsResponse] = await Promise.all([getBotState(signal), getBotStats(signal)]);
      setCachedBotState(nextState);
      setStats(statsResponse.stats);
    } catch {
      // no-op
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshBotData(controller.signal);

    const interval = window.setInterval(() => {
      const tickController = new AbortController();
      void refreshBotData(tickController.signal);
    }, 5000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshBotData]);

  const symbolRows = useMemo<ActiveSymbolRow[]>(() => {
    const contractSymbols = cachedBotState.symbols ?? [];
    if (contractSymbols.length > 0) {
      return contractSymbols.map((row) => ({
        symbol: row.symbol,
        markPrice: Number.isFinite(row.markPrice) ? row.markPrice : null,
        openInterestValue: Number.isFinite(row.openInterestValue) ? row.openInterestValue : null,
        priceDeltaPct: Number.isFinite(row.priceDeltaPct) ? row.priceDeltaPct : null,
        oiDeltaPct: Number.isFinite(row.oiDeltaPct) ? row.oiDeltaPct : null,
        fundingRate: row.fundingRate,
        nextFundingTimeMs: row.nextFundingTimeMs,
        timeToFundingMs: row.timeToFundingMs,
        fundingAgeMs: row.fundingAgeMs ?? null,
        fundingStatus: row.fundingStatus ?? (row.fundingRate == null ? 'MISSING' : 'OK'),
        tradability: row.tradability,
        signalCount24h: row.signalCount24h,
        lastSignalAtMs: row.lastSignalAtMs,
        blackoutReason: row.blackoutReason ?? null,
        topReason: row.topReasons?.[0]?.message ?? symbolMap[row.symbol]?.topReasons?.[0]?.message ?? null
      }));
    }

    const diagnostics = cachedBotState.activeSymbolDiagnostics ?? [];
    return diagnostics.map((diag) => {
      const ws = symbolMap[diag.symbol];
      return {
        symbol: diag.symbol,
        markPrice: ws?.markPrice ?? null,
        openInterestValue: ws?.openInterestValue ?? null,
        priceDeltaPct: null,
        oiDeltaPct: null,
        fundingRate: diag.fundingRate ?? null,
        nextFundingTimeMs: diag.nextFundingTimeMs ?? null,
        timeToFundingMs: diag.timeToFundingMs ?? null,
        fundingAgeMs: diag.fundingAgeMs ?? null,
        fundingStatus: diag.fundingStatus ?? (diag.fundingRate == null ? 'MISSING' : 'OK'),
        tradability: diag.tradingAllowed ?? 'MISSING',
        signalCount24h: diag.signalCount24h ?? 0,
        lastSignalAtMs: diag.lastSignalAt ?? null,
        blackoutReason: null,
        topReason: diag.topReasons?.[0]?.message ?? ws?.topReasons?.[0]?.message ?? null
      };
    });
  }, [cachedBotState.activeSymbolDiagnostics, cachedBotState.symbols, symbolMap]);

  const perSymbolRows = useMemo(() => toPerSymbolRows(stats), [stats]);
  const { sortedRows: sortedPerSymbolRows, sortState, setSortKey } = useSort<PerSymbolResultsRow>(
    perSymbolRows,
    { key: 'symbol', dir: 'asc' },
    { tableId: 'bot-per-symbol-results' }
  );
  const {
    sortedRows: sortedActiveSymbolRows,
    sortState: activeSortState,
    setSortKey: setActiveSortKey
  } = useSort<ActiveSymbolRow>(symbolRows, { key: 'symbol', dir: 'asc' }, {
    tableId: 'bot-active-symbols',
    getSortValue: (row, key) => {
      if (key === 'nextFundingTimeMs') return row.nextFundingTimeMs ?? null;
      if (key === 'fundingRate') return row.fundingRate ?? null;
      return (row as Record<string, unknown>)[String(key)];
    }
  });

  const onStart = async () => {
    setError('');
    setStatus('');
    try {
      await startBot({
        tf: settings.tf,
        priceUpThrPct: settings.priceUpThrPct,
        oiUpThrPct: settings.oiUpThrPct,
        minFundingAbs: settings.minFundingAbs,
        signalCounterMin: settings.signalCounterMin,
        signalCounterMax: settings.signalCounterMax,
        minTriggerCount: settings.signalCounterMin,
        maxTriggerCount: settings.signalCounterMax
      } as unknown as BotSettings);
      setStatus('Bot started');
      await syncRest();
      await refreshBotData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onStop = async () => {
    setError('');
    setStatus('');
    try {
      await stopBot();
      setStatus('Bot stopped (open orders cancelled, positions left open)');
      await syncRest();
      await refreshBotData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onPause = async () => {
    setError('');
    setStatus('');
    try {
      await pauseBot();
      setStatus('Bot paused (orders and positions kept)');
      await syncRest();
      await refreshBotData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onKill = async () => {
    setError('');
    setStatus('');
    try {
      await killBot();
      setStatus('Bot KILL executed');
      await syncRest();
      await refreshBotData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onReset = async () => {
    setError('');
    setStatus('');
    try {
      await resetBot();
      setStatus('Bot reset completed (KILL + universe cleared)');
      await syncRest();
      await refreshBotData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRefreshNow = async () => {
    await syncRest();
    await refreshBotData();
  };

  const isStopped = !cachedBotState.running;
  const canKill = cachedBotState.running || cachedBotState.activeOrders > 0 || cachedBotState.openPositions > 0;

  const renderSortMarker = (key: keyof PerSymbolResultsRow) => {
    if (sortState?.key !== key) return null;
    return sortState.dir === 'asc' ? ' ▲' : ' ▼';
  };

  const renderActiveSortMarker = (key: keyof ActiveSymbolRow) => {
    if (activeSortState?.key !== key) return null;
    return activeSortState.dir === 'asc' ? ' ▲' : ' ▼';
  };

  return (
    <div className="d-grid gap-3">
      {status ? <Alert variant="success">{status}</Alert> : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}

      <Tabs defaultActiveKey="dashboard" id="bot-tabs" className="mb-2">
        <Tab eventKey="dashboard" title="Dashboard">
          <Card className="mt-3"><Card.Body>
            <Row className="g-2">
              <Col md={8}><strong>Lifecycle:</strong> {cachedBotState.running ? (cachedBotState.paused ? 'PAUSED' : 'RUNNING') : 'STOPPED'} · uptime {formatDuration(cachedBotState.uptimeMs)}</Col>
              <Col md={4} className="text-md-end"><strong>Symbol updates/sec:</strong> {symbolUpdatesPerSecond}</Col>
            </Row>
          </Card.Body></Card>

          <Card className="mt-3"><Card.Body>
            <Card.Title>Lifecycle</Card.Title>
            <div className="d-flex gap-2 flex-wrap">
              <Button size="sm" onClick={() => void onStart()} disabled={cachedBotState.running && !cachedBotState.paused}>Start</Button>
              <Button size="sm" variant="outline-warning" onClick={() => void onStop()} disabled={!cachedBotState.running && !cachedBotState.paused}>Stop</Button>
              <Button size="sm" variant="outline-secondary" onClick={() => void onPause()} disabled={!cachedBotState.running || cachedBotState.paused}>Pause</Button>
              <Button size="sm" variant="danger" onClick={() => void onKill()} disabled={!canKill}>KILL</Button>
              <Button size="sm" variant="outline-dark" onClick={() => void onReset()} disabled={!isStopped}>Reset</Button>
              <Button size="sm" variant="outline-primary" onClick={() => void onRefreshNow()}>Refresh</Button>
            </div>
            <div className="small text-muted mt-2">Stop cancels open orders only · Pause keeps open orders · KILL cancels+flattens · Reset = KILL + universe clear.</div>
          </Card.Body></Card>

          <Card className="mt-3"><Card.Body>
            <Card.Title>Trading stats summary</Card.Title>
            <Row className="g-2">
              <Col md={4}><strong>Activity</strong><div className="small">Trades: {stats?.totalTrades ?? 0} · Wins: {stats?.wins ?? 0} · Losses: {stats?.losses ?? 0} · Winrate: {(stats?.winratePct ?? 0).toFixed(2)}% · Longs: {stats?.long?.trades ?? 0} · Shorts: {stats?.short?.trades ?? 0} · LastTradeAt: {stats?.lastClosed?.ts ? new Date(stats.lastClosed.ts).toLocaleString() : '—'}</div></Col>
              <Col md={4}><strong>PnL</strong><div className="small">Total PnL: {(stats?.pnlUSDT ?? 0).toFixed(2)} · Today PnL: {(stats?.todayPnlUSDT ?? 0).toFixed(2)} · Avg Win: {stats?.avgWinUSDT == null ? '—' : stats.avgWinUSDT.toFixed(2)} · Avg Loss: {stats?.avgLossUSDT == null ? '—' : stats.avgLossUSDT.toFixed(2)}</div></Col>
              <Col md={4}><strong>Costs</strong><div className="small">Fees: {(stats?.totalFeesUSDT ?? 0).toFixed(2)} · Slippage: {(stats?.totalSlippageUSDT ?? 0).toFixed(2)} · Avg spread entry: {stats?.avgSpreadBpsEntry == null ? '—' : stats.avgSpreadBpsEntry.toFixed(2)}bps · Avg spread exit: {stats?.avgSpreadBpsExit == null ? '—' : stats.avgSpreadBpsExit.toFixed(2)}bps</div></Col>
            </Row>
          </Card.Body></Card>
        </Tab>

        <Tab eventKey="settings" title="Settings">
          <Card className="mt-3"><Card.Body>
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

          <Card className="mt-3"><Card.Body>
            <Card.Title>Settings (v2)</Card.Title>
            <Row className="g-2">
              <Col md={2}><Form.Label>TF</Form.Label><Form.Select value={settings.tf} onChange={(e) => setSettings((s) => ({ ...s, tf: Number(e.target.value) as MinimalSettings['tf'] }))}>{[1,3,5,10,15].map((v)=><option key={v} value={v}>{v}m</option>)}</Form.Select></Col>
              <Col md={2}><Form.Label>priceUpThrPct</Form.Label><Form.Control type="number" value={settings.priceUpThrPct} onChange={(e) => setSettings((s) => ({ ...s, priceUpThrPct: Number(e.target.value) }))} /></Col>
              <Col md={2}><Form.Label>oiUpThrPct</Form.Label><Form.Control type="number" value={settings.oiUpThrPct} onChange={(e) => setSettings((s) => ({ ...s, oiUpThrPct: Number(e.target.value) }))} /></Col>
              <Col md={2}><Form.Label>Min Funding (abs)</Form.Label><Form.Control type="number" value={settings.minFundingAbs ?? 0} onChange={(e) => setSettings((s) => ({ ...s, minFundingAbs: Number(e.target.value) }))} /><Form.Text className="text-muted">Blocks trading if |funding| is below this threshold. Sign is taken from live funding.</Form.Text></Col>
              <Col md={2}><Form.Label>minTriggerCount</Form.Label><Form.Control type="number" value={settings.signalCounterMin} onChange={(e) => setSettings((s) => ({ ...s, signalCounterMin: Number(e.target.value) }))} /></Col>
              <Col md={2}><Form.Label>maxTriggerCount</Form.Label><Form.Control type="number" value={settings.signalCounterMax} onChange={(e) => setSettings((s) => ({ ...s, signalCounterMax: Number(e.target.value) }))} /></Col>
            </Row>
            <div className="small text-muted mt-2">Percent convention: 3 means 3%.</div>
          </Card.Body></Card>
        </Tab>

        <Tab eventKey="active-symbols" title="Active symbols">
          <Card className="mt-3"><Card.Body>
            <Card.Title>Active symbols</Card.Title>
            <div className="small text-muted mb-2">Funding snapshots refresh every 10 minutes (batch, best-effort).</div>
            <Table size="sm" striped responsive>
              <thead><tr>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('symbol')}>Symbol{renderActiveSortMarker('symbol')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('markPrice')}>Mark{renderActiveSortMarker('markPrice')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('openInterestValue')}>OIV{renderActiveSortMarker('openInterestValue')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('priceDeltaPct')}>ΔPrice%{renderActiveSortMarker('priceDeltaPct')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('oiDeltaPct')}>ΔOIV%{renderActiveSortMarker('oiDeltaPct')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('fundingRate')}>Funding{renderActiveSortMarker('fundingRate')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('nextFundingTimeMs')}>Next funding (ETA){renderActiveSortMarker('nextFundingTimeMs')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('tradability')}>Tradability{renderActiveSortMarker('tradability')}</Button></th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('signalCount24h')}>SignalCount{renderActiveSortMarker('signalCount24h')}</Button></th>
                <th>Top no-entry reason</th>
                <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setActiveSortKey('lastSignalAtMs')}>LastSignal{renderActiveSortMarker('lastSignalAtMs')}</Button></th>
              </tr></thead>
              <tbody>
                {sortedActiveSymbolRows.map((row) => (
                  <tr key={row.symbol}>
                    <td>{row.symbol}</td>
                    <td className="font-monospace">{row.markPrice ?? '—'}</td>
                    <td className="font-monospace">{row.openInterestValue ?? '—'}</td>
                    <td className="font-monospace">{row.priceDeltaPct == null ? '—' : row.priceDeltaPct.toFixed(3)}</td>
                    <td className="font-monospace">{row.oiDeltaPct == null ? '—' : row.oiDeltaPct.toFixed(3)}</td>
                    <td className="font-monospace">{row.fundingRate == null ? <Badge bg="danger">MISSING</Badge> : row.fundingRate}</td>
                    <td className="font-monospace">{row.nextFundingTimeMs ? `${new Date(row.nextFundingTimeMs).toLocaleString()} (${toHuman(row.timeToFundingMs)})` : '—'}{row.fundingStatus === 'STALE' ? ' · stale' : ''}</td>
                    <td><Badge bg={row.tradability === 'OK' ? 'success' : row.tradability === 'MISSING' ? 'danger' : 'warning'}>{row.tradability}</Badge></td>
                    <td className="font-monospace">{row.signalCount24h}</td>
                    <td className="small">{row.topReason ?? 'No reasons available yet'}</td>
                    <td className="font-monospace">{row.lastSignalAtMs ? new Date(row.lastSignalAtMs).toLocaleTimeString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card.Body></Card>
        </Tab>

        <Tab eventKey="per-symbol-results" title="Per-symbol results">
          <Card className="mt-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>Per-symbol results</span>
              <Button size="sm" onClick={() => void onRefreshNow()}>Refresh</Button>
            </Card.Header>
            <Card.Body>
              <Table size="sm" striped responsive>
                <thead>
                  <tr>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('symbol')}>Symbol{renderSortMarker('symbol')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('trades')}>Trades{renderSortMarker('trades')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('wins')}>Wins{renderSortMarker('wins')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('losses')}>Losses{renderSortMarker('losses')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('winrate')}>Winrate{renderSortMarker('winrate')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('longs')}>Longs{renderSortMarker('longs')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('shorts')}>Shorts{renderSortMarker('shorts')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('pnlUSDT')}>PnL{renderSortMarker('pnlUSDT')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('avgWinUSDT')}>AvgWin{renderSortMarker('avgWinUSDT')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('avgLossUSDT')}>AvgLoss{renderSortMarker('avgLossUSDT')}</Button></th>
                    <th><Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey('lastTradeAt')}>LastTradeAt{renderSortMarker('lastTradeAt')}</Button></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPerSymbolRows.map((row) => (
                    <tr key={row.symbol}>
                      <td>{row.symbol}</td>
                      <td className="font-monospace">{row.trades}</td>
                      <td className="font-monospace">{row.wins}</td>
                      <td className="font-monospace">{row.losses}</td>
                      <td className="font-monospace">{row.winrate.toFixed(2)}%</td>
                      <td className="font-monospace">{row.longs}</td>
                      <td className="font-monospace">{row.shorts}</td>
                      <td className="font-monospace">{row.pnlUSDT === null ? '—' : row.pnlUSDT.toFixed(2)}</td>
                      <td className="font-monospace">{row.avgWinUSDT === null ? '—' : row.avgWinUSDT.toFixed(2)}</td>
                      <td className="font-monospace">{row.avgLossUSDT === null ? '—' : row.avgLossUSDT.toFixed(2)}</td>
                      <td className="font-monospace">{row.lastTradeAt ? new Date(row.lastTradeAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {sortedPerSymbolRows.length === 0 ? <div className="small text-muted">No per-symbol results yet.</div> : null}
            </Card.Body>
          </Card>
        </Tab>
      </Tabs>
    </div>
  );
}

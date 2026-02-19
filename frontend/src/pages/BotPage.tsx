import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row, Tab, Table, Tabs } from 'react-bootstrap';

import {
  ApiError,
  createUniverse,
  getBotConfig,
  getBotStats,
  getUniverse,
  getUniverseConfig,
  resetBot,
  saveBotConfig,
  saveUniverseConfig,
  startBot,
  stopBot
} from '../api';
import { useSort } from '../hooks/useSort';
import type { BotState, BotStateSymbol } from '../types';
import { formatDuration } from '../utils/time';

type Props = {
  onRefresh: () => Promise<void>;
  botState: BotState | null;
};

type UniverseSymbolStatus = 'WAIT_CANDLE' | 'WAIT_SIGNAL' | 'WAIT_CONFIRMATION' | 'ORDER_PLACED' | 'POSITION_OPEN' | 'BLACKOUT';

type UniverseRow = {
  symbol: string;
  markPrice: number;
  priceDeltaPct: number | null;
  oiDeltaPct: number | null;
  fundingRate: number | null;
  nextFundingTimeMs: number | null;
  timeToFundingMs: number | null;
  status: UniverseSymbolStatus;
  statusLabel: string;
  blackoutReason: string | null;
};

const MOSCOW_TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

const STATUS_LABELS: Record<UniverseSymbolStatus, string> = {
  WAIT_CANDLE: 'Ожидаю формирование свечи',
  WAIT_SIGNAL: 'Ожидаю сигнал',
  WAIT_CONFIRMATION: 'Ожидаю подтверждения',
  ORDER_PLACED: 'Ордер размещен',
  POSITION_OPEN: 'Позиция открыта',
  BLACKOUT: 'Blackout'
};

const formatNumber = (value: number | null, digits = 4) => {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }

  return value.toFixed(digits);
};

const formatPercent = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) {
    return '—';
  }

  return `${value.toFixed(digits)}%`;
};

const getSymbolStatus = (row: BotStateSymbol, botState: BotState | null): UniverseSymbolStatus => {
  if (row.tradability === 'BLACKOUT') {
    return 'BLACKOUT';
  }

  if (row.priceDeltaPct === null || row.oiDeltaPct === null) {
    return 'WAIT_CANDLE';
  }

  const openPositionSymbols = new Set((botState?.positions ?? []).map((position) => position.symbol));
  if (openPositionSymbols.has(row.symbol)) {
    return 'POSITION_OPEN';
  }

  const openOrderSymbols = new Set((botState?.openOrders ?? []).map((order) => order.symbol));
  if (openOrderSymbols.has(row.symbol)) {
    return 'ORDER_PLACED';
  }

  if (row.signalCount24h <= 0) {
    return 'WAIT_SIGNAL';
  }

  const minTriggerCount = botState?.config?.minTriggerCount;
  if (typeof minTriggerCount === 'number' && row.signalCount24h < minTriggerCount) {
    return 'WAIT_CONFIRMATION';
  }

  return 'WAIT_SIGNAL';
};

const sortArrow = (active: boolean, dir: 'asc' | 'desc' | null) => {
  if (!active || dir === null) {
    return '↕';
  }
  return dir === 'asc' ? '↑' : '↓';
};

export function BotPage({ onRefresh, botState }: Props) {
  const [settings, setSettings] = useState({ tf: 1, priceUpThrPct: 0.5, oiUpThrPct: 3, minFundingAbs: 0, signalCounterMin: 2, signalCounterMax: 3 });
  const [universe, setUniverse] = useState({ minVolPct: 10, minTurnover: 10_000_000 });
  const [stats, setStats] = useState<{ totalTrades: number; pnlUSDT: number } | null>(null);
  const [msg, setMsg] = useState<string>('');
  const [err, setErr] = useState<string>('');

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, uniCfg, uni, botStats] = await Promise.all([getBotConfig(), getUniverseConfig(), getUniverse(), getBotStats()]);
        setSettings((prev) => ({ ...prev, ...cfg.config }));
        setUniverse(uniCfg.config);
        if (uni.filters) {
          setUniverse({ minVolPct: uni.filters.minVolPct, minTurnover: uni.filters.minTurnover });
        }
        setStats({ totalTrades: botStats.stats.totalTrades, pnlUSDT: botStats.stats.pnlUSDT });
      } catch {
        // noop
      }
    })();
  }, []);

  const renderError = (error: unknown): string => {
    if (error instanceof ApiError) {
      return error.message === error.code ? error.code : `${error.code}: ${error.message}`;
    }
    if (error instanceof Error) {
      return error.message;
    }
    return 'UNKNOWN_ERROR';
  };

  const run = async (fn: () => Promise<unknown>, text: string) => {
    setErr('');
    try {
      const nextMessage = await fn();
      setMsg(typeof nextMessage === 'string' ? nextMessage : text);
      await onRefresh();
    } catch (e) {
      setErr(renderError(e));
    }
  };

  const universeRows = useMemo<UniverseRow[]>(() => {
    return (botState?.symbols ?? []).map((row) => {
      const status = getSymbolStatus(row, botState);
      return {
        symbol: row.symbol,
        markPrice: row.markPrice,
        priceDeltaPct: row.priceDeltaPct,
        oiDeltaPct: row.oiDeltaPct,
        fundingRate: row.fundingRate,
        nextFundingTimeMs: row.nextFundingTimeMs,
        timeToFundingMs: row.timeToFundingMs,
        status,
        statusLabel: STATUS_LABELS[status],
        blackoutReason: row.blackoutReason ?? null
      };
    });
  }, [botState]);

  const { sortState, sortedRows, setSortKey } = useSort(universeRows, { key: 'symbol', dir: 'asc' }, {
    tableId: 'universe-symbols',
    getSortValue: (row, key) => {
      switch (key) {
        case 'nextFundingTimeMs':
          return row.nextFundingTimeMs ?? Number.POSITIVE_INFINITY;
        default:
          return row[key as keyof UniverseRow] ?? null;
      }
    }
  });

  const renderSortHeader = (label: string, key: keyof UniverseRow) => {
    const isActive = sortState?.key === key;
    const dir = isActive ? sortState.dir : null;

    return (
      <Button variant="link" className="p-0 text-decoration-none" onClick={() => setSortKey(key)}>
        {label} {sortArrow(isActive, dir)}
      </Button>
    );
  };

  return (
    <div className="d-grid gap-3">
      {msg ? <Alert variant="success">{msg}</Alert> : null}
      {err ? <Alert variant="danger">{err}</Alert> : null}

      <Tabs defaultActiveKey="bot" id="bot-page-tabs" className="mb-1">
        <Tab eventKey="bot" title="Bot">
          <div className="d-grid gap-3 mt-3">
            <Card><Card.Header>Dashboard</Card.Header><Card.Body>
              <div>Status: <strong>{botState?.running ? 'RUNNING' : 'STOPPED'}</strong></div>
              <div>Uptime: {formatDuration(botState?.uptimeMs ?? 0)}</div>
              <div>Queue depth: {botState?.queueDepth ?? 0} · Active orders: {botState?.activeOrders ?? 0} · Open positions: {botState?.openPositions ?? 0}</div>
              <div>Total trades: {stats?.totalTrades ?? 0} · PnL: {stats?.pnlUSDT ?? 0}</div>
            </Card.Body></Card>

            <Card><Card.Header>Control</Card.Header><Card.Body className="d-flex gap-2">
              <Button onClick={() => run(() => startBot(), 'Bot started')}>Start</Button>
              <Button variant="warning" onClick={() => run(() => stopBot(), 'Bot stopped (orders cancelled, positions kept)')}>Stop</Button>
              <Button variant="danger" onClick={() => run(() => resetBot(), 'Bot reset (orders cancelled, positions closed, stats/runtime reset)')}>Reset</Button>
            </Card.Body></Card>

            <Card><Card.Header>Universe</Card.Header><Card.Body>
              <Row className="g-2">
                <Col md={6}><Form.Label>Min vol %</Form.Label><Form.Control type="number" value={universe.minVolPct} onChange={(e) => setUniverse((p) => ({ ...p, minVolPct: Number(e.target.value) }))} /></Col>
                <Col md={6}><Form.Label>Min turnover</Form.Label><Form.Control type="number" value={universe.minTurnover} onChange={(e) => setUniverse((p) => ({ ...p, minTurnover: Number(e.target.value) }))} /></Col>
              </Row>
              <Button className="mt-3" onClick={() => run(async () => {
                await saveUniverseConfig(universe);
                try {
                  const result = await createUniverse(universe);
                  const total = result.totals?.totalSymbols ?? 0;
                  const valid = result.totals?.validSymbols ?? 0;
                  const passed = result.passed ?? 0;
                  return `Universe built: total=${total}, valid=${valid}, passed=${passed}`;
                } catch (error) {
                  if (error instanceof ApiError && error.code === 'HTTP_502') {
                    const hasLastKnown = (error.details as { lastKnownUniverseAvailable?: boolean } | undefined)?.lastKnownUniverseAvailable;
                    throw new ApiError(error.status, error.code, `Universe build failed${hasLastKnown ? ' (lastKnownUniverseAvailable=true)' : ''}`, error.details);
                  }
                  throw error;
                }
              }, 'Universe config saved')}>Save</Button>
            </Card.Body></Card>

            <Card><Card.Header>Settings</Card.Header><Card.Body>
              <Row className="g-2">
                <Col md={4}><Form.Label>TF</Form.Label><Form.Control type="number" value={settings.tf} onChange={(e) => setSettings((p) => ({ ...p, tf: Number(e.target.value) }))} /></Col>
                <Col md={4}><Form.Label>ΔPrice% (модуль) к прошлой свече TF</Form.Label><Form.Control type="number" value={settings.priceUpThrPct} onChange={(e) => setSettings((p) => ({ ...p, priceUpThrPct: Number(e.target.value) }))} /></Col>
                <Col md={4}><Form.Label>ΔOIV% (модуль) к прошлой свече TF</Form.Label><Form.Control type="number" value={settings.oiUpThrPct} onChange={(e) => setSettings((p) => ({ ...p, oiUpThrPct: Number(e.target.value) }))} /></Col>
                <Col md={4}><Form.Label>Min funding abs</Form.Label><Form.Control type="number" value={settings.minFundingAbs} onChange={(e) => setSettings((p) => ({ ...p, minFundingAbs: Number(e.target.value) }))} /></Col>
                <Col xs={12}><Form.Text className="text-muted">Порог применяется к модулю изменения. Направление сделки определяется знаком funding.</Form.Text></Col>
                <Col md={4}><Form.Label>Min trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMin} onChange={(e) => setSettings((p) => ({ ...p, signalCounterMin: Number(e.target.value) }))} /></Col>
                <Col md={4}><Form.Label>Max trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMax} onChange={(e) => setSettings((p) => ({ ...p, signalCounterMax: Number(e.target.value) }))} /></Col>
              </Row>
              <Button className="mt-3" onClick={() => run(() => saveBotConfig(settings as never), 'Bot settings saved')}>Save</Button>
            </Card.Body></Card>
          </div>
        </Tab>

        <Tab eventKey="universe-symbols" title="Universe symbols">
          <Card className="mt-3">
            <Card.Header className="d-flex justify-content-between align-items-center">
              <span>Universe symbols</span>
              <Button size="sm" onClick={() => void onRefresh()}>Refresh</Button>
            </Card.Header>
            <Card.Body>
              {sortedRows.length === 0 ? (
                <div className="text-muted">Universe symbols are not available yet.</div>
              ) : (
                <Table responsive hover size="sm" className="mb-0 align-middle">
                  <thead>
                    <tr>
                      <th>{renderSortHeader('Symbol', 'symbol')}</th>
                      <th>{renderSortHeader('Current price (mark)', 'markPrice')}</th>
                      <th>{renderSortHeader('ΔPrice% vs prev TF', 'priceDeltaPct')}</th>
                      <th>{renderSortHeader('ΔOIV% vs prev TF', 'oiDeltaPct')}</th>
                      <th>{renderSortHeader('Funding rate', 'fundingRate')}</th>
                      <th>{renderSortHeader('Funding update (MSK)', 'nextFundingTimeMs')}</th>
                      <th>{renderSortHeader('Status', 'status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row) => (
                      <tr key={row.symbol}>
                        <td>{row.symbol}</td>
                        <td>{formatNumber(row.markPrice, 6)}</td>
                        <td>{formatPercent(row.priceDeltaPct, 2)}</td>
                        <td>{formatPercent(row.oiDeltaPct, 2)}</td>
                        <td>{formatPercent(row.fundingRate, 5)}</td>
                        <td>
                          {row.nextFundingTimeMs === null
                            ? '—'
                            : `${MOSCOW_TIME_FORMAT.format(new Date(row.nextFundingTimeMs))} (${formatDuration(Math.max(0, row.timeToFundingMs ?? 0))})`}
                        </td>
                        <td title={row.blackoutReason ?? undefined}>{row.statusLabel}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card.Body>
          </Card>
        </Tab>
      </Tabs>
    </div>
  );
}

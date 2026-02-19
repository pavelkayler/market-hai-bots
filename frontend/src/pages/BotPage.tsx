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
import type { BotState, UniverseSymbolStatus } from '../types';
import { formatDuration } from '../utils/time';

type Props = {
  onRefresh: () => Promise<void>;
  botState: BotState | null;
};

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
  noEntryReason: string | null;
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

const sortArrow = (active: boolean, dir: 'asc' | 'desc' | null) => {
  if (!active || dir === null) {
    return '↕';
  }
  return dir === 'asc' ? '↑' : '↓';
};

export function BotPage({ onRefresh, botState }: Props) {
  const [settings, setSettings] = useState({
    tf: 1,
    priceUpThrPct: 0.5,
    oiUpThrPct: 3,
    minFundingAbs: 0,
    signalCounterMin: 2,
    signalCounterMax: 3,
    marginUSDT: 100,
    leverage: 10,
    entryOffsetPct: 0.01,
    tpRoiPct: 0.3,
    slRoiPct: 0.3
  });
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

  useEffect(() => {
    if (!botState?.config) {
      return;
    }

    setSettings((prev) => ({
      ...prev,
      tf: botState.config?.tfMinutes ?? prev.tf,
      priceUpThrPct: botState.config?.priceUpThrPct ?? prev.priceUpThrPct,
      oiUpThrPct: botState.config?.oiUpThrPct ?? prev.oiUpThrPct,
      minFundingAbs: botState.config?.minFundingAbs ?? prev.minFundingAbs,
      signalCounterMin: botState.config?.minTriggerCount ?? prev.signalCounterMin,
      signalCounterMax: botState.config?.maxTriggerCount ?? prev.signalCounterMax,
      marginUSDT: botState.config?.marginUSDT ?? prev.marginUSDT,
      leverage: botState.config?.leverage ?? prev.leverage,
      entryOffsetPct: botState.config?.entryOffsetPct ?? prev.entryOffsetPct,
      tpRoiPct: botState.config?.tpRoiPct ?? prev.tpRoiPct,
      slRoiPct: botState.config?.slRoiPct ?? prev.slRoiPct
    }));
  }, [botState?.config]);

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
      const status = row.statusCode ?? (row.priceDeltaPct === null || row.oiDeltaPct === null ? 'WAIT_CANDLE' : 'WAIT_SIGNAL');
      return {
        symbol: row.symbol,
        markPrice: row.markPrice,
        priceDeltaPct: row.priceDeltaPct,
        oiDeltaPct: row.oiDeltaPct,
        fundingRate: row.fundingRate,
        nextFundingTimeMs: row.nextFundingTimeMs,
        timeToFundingMs: row.timeToFundingMs,
        status,
        statusLabel: row.statusLabel ?? STATUS_LABELS[status],
        blackoutReason: row.blackoutReason ?? null,
        noEntryReason: row.noEntryReason ?? null
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

  const parseNumericInput = (value: string): number | null => {
    if (value.trim() === '') {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const updateSetting = <K extends keyof typeof settings>(key: K, value: string) => {
    const parsed = parseNumericInput(value);
    if (parsed === null) {
      return;
    }

    setSettings((prev) => ({ ...prev, [key]: parsed }));
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
                <Col md={4}><Form.Label>TF</Form.Label><Form.Control type="number" value={settings.tf} onChange={(e) => updateSetting('tf', e.target.value)} /></Col>
                <Col md={4}><Form.Label>ΔPrice% (модуль) к прошлой свече TF</Form.Label><Form.Control type="number" value={settings.priceUpThrPct} onChange={(e) => updateSetting('priceUpThrPct', e.target.value)} /></Col>
                <Col md={4}><Form.Label>ΔOIV% (модуль) к прошлой свече TF</Form.Label><Form.Control type="number" value={settings.oiUpThrPct} onChange={(e) => updateSetting('oiUpThrPct', e.target.value)} /></Col>
                <Col md={4}><Form.Label>Min funding abs</Form.Label><Form.Control type="number" value={settings.minFundingAbs} onChange={(e) => updateSetting('minFundingAbs', e.target.value)} /></Col>
                <Col xs={12}><Form.Text className="text-muted">Порог применяется к модулю изменения. Направление сделки определяется знаком funding.</Form.Text></Col>
                <Col md={4}><Form.Label>Min trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMin} onChange={(e) => updateSetting('signalCounterMin', e.target.value)} /></Col>
                <Col md={4}><Form.Label>Max trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMax} onChange={(e) => updateSetting('signalCounterMax', e.target.value)} /></Col>

                <Col xs={12}><hr className="my-2" /></Col>
                <Col xs={12}><h6 className="mb-1">Entry settings</h6></Col>
                <Col md={4}><Form.Label>Margin (USDT)</Form.Label><Form.Control type="number" value={settings.marginUSDT} onChange={(e) => updateSetting('marginUSDT', e.target.value)} /></Col>
                <Col md={4}><Form.Label>Leverage</Form.Label><Form.Control type="number" value={settings.leverage} onChange={(e) => updateSetting('leverage', e.target.value)} /></Col>
                <Col md={4}><Form.Label>Entry offset (%)</Form.Label><Form.Control type="number" value={settings.entryOffsetPct} onChange={(e) => updateSetting('entryOffsetPct', e.target.value)} /></Col>
                <Col md={4}><Form.Label>TP (%)</Form.Label><Form.Control type="number" value={settings.tpRoiPct} onChange={(e) => updateSetting('tpRoiPct', e.target.value)} /></Col>
                <Col md={4}><Form.Label>SL (%)</Form.Label><Form.Control type="number" value={settings.slRoiPct} onChange={(e) => updateSetting('slRoiPct', e.target.value)} /></Col>
                <Col xs={12}><Form.Text className="text-muted">Entry offset: LONG limit = mark × (1 - offset/100), SHORT limit = mark × (1 + offset/100).</Form.Text></Col>
                <Col xs={12}><Form.Text className="text-muted">TP/SL are ROI% thresholds calculated on margin.</Form.Text></Col>
              </Row>
              <Button
                className="mt-3"
                onClick={() => run(() => {
                  const minTriggerCount = Math.max(1, Math.floor(settings.signalCounterMin));
                  const maxTriggerCount = Math.max(minTriggerCount, Math.min(1000, Math.floor(settings.signalCounterMax)));
                  return saveBotConfig({ ...settings, signalCounterMin: minTriggerCount, signalCounterMax: maxTriggerCount } as never);
                }, 'Bot settings saved')}
              >
                Save
              </Button>
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
                      <th>{renderSortHeader('Why', 'noEntryReason')}</th>
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
                        <td title={row.blackoutReason ?? undefined}>
                          {row.status === 'BLACKOUT'
                            ? 'Blackout'
                            : row.status === 'WAIT_SIGNAL' || row.status === 'WAIT_CANDLE' || row.status === 'WAIT_CONFIRMATION'
                              ? (row.noEntryReason ?? '—')
                              : '—'}
                        </td>
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

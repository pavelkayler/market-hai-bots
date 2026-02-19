import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Form, Row } from 'react-bootstrap';

import { ApiError, createUniverse, getBotConfig, getBotStats, getUniverse, getUniverseConfig, resetBot, saveBotConfig, saveUniverseConfig, startBot, stopBot } from '../api';
import type { BotState } from '../types';
import { formatDuration } from '../utils/time';

type Props = {
  onRefresh: () => Promise<void>;
  botState: BotState | null;
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

  return (
    <div className="d-grid gap-3">
      {msg ? <Alert variant="success">{msg}</Alert> : null}
      {err ? <Alert variant="danger">{err}</Alert> : null}

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
          <Col md={4}><Form.Label>Price up %</Form.Label><Form.Control type="number" value={settings.priceUpThrPct} onChange={(e) => setSettings((p) => ({ ...p, priceUpThrPct: Number(e.target.value) }))} /></Col>
          <Col md={4}><Form.Label>OI up %</Form.Label><Form.Control type="number" value={settings.oiUpThrPct} onChange={(e) => setSettings((p) => ({ ...p, oiUpThrPct: Number(e.target.value) }))} /></Col>
          <Col md={4}><Form.Label>Min funding abs</Form.Label><Form.Control type="number" value={settings.minFundingAbs} onChange={(e) => setSettings((p) => ({ ...p, minFundingAbs: Number(e.target.value) }))} /></Col>
          <Col md={4}><Form.Label>Min trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMin} onChange={(e) => setSettings((p) => ({ ...p, signalCounterMin: Number(e.target.value) }))} /></Col>
          <Col md={4}><Form.Label>Max trigger count</Form.Label><Form.Control type="number" value={settings.signalCounterMax} onChange={(e) => setSettings((p) => ({ ...p, signalCounterMax: Number(e.target.value) }))} /></Col>
        </Row>
        <Button className="mt-3" onClick={() => run(() => saveBotConfig(settings as never), 'Bot settings saved')}>Save</Button>
      </Card.Body></Card>
    </div>
  );
}

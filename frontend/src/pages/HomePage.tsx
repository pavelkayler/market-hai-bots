import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, ListGroup } from 'react-bootstrap';
import { Link } from 'react-router-dom';

import { getBotStats, getDoctor } from '../api';
import type { BotState, BotStats, DoctorResponse } from '../types';
import { formatDuration } from '../utils/time';

type Props = {
  restHealthy: boolean;
  wsConnected: boolean;
  botState: BotState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

export function HomePage({ restHealthy, wsConnected, botState, onPause, onResume, onStop }: Props) {
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [doctorError, setDoctorError] = useState('');
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [botStats, setBotStats] = useState<BotStats>({
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winratePct: 0,
    pnlUSDT: 0,
    avgWinUSDT: null,
    avgLossUSDT: null,
    lossStreak: 0,
    todayPnlUSDT: 0,
    guardrailPauseReason: null,
    long: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
    short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 }
  });

  const selectedMode = botState.mode ?? botState.lastConfig?.mode ?? null;

  const refreshDoctor = async () => {
    setDoctorLoading(true);
    setDoctorError('');
    try {
      const response = await getDoctor();
      setDoctor(response);
    } catch (error) {
      setDoctorError((error as Error).message);
    } finally {
      setDoctorLoading(false);
    }
  };

  const refreshBotStats = async () => {
    try {
      const response = await getBotStats();
      setBotStats(response.stats);
    } catch {
      // no-op
    }
  };

  useEffect(() => {
    void refreshDoctor();
    void refreshBotStats();
  }, []);

  useEffect(() => {
    if (!botState.running && botState.activeOrders === 0 && botState.openPositions === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshBotStats();
    }, 12000);

    return () => window.clearInterval(interval);
  }, [botState.activeOrders, botState.openPositions, botState.running]);

  const warnings = useMemo(() => {
    if (!doctor) {
      return [];
    }

    const messages: string[] = [];
    if (!doctor.universe.ready) {
      messages.push('Universe is not ready. Create the universe before starting the bot.');
    }

    if (!doctor.market.running) {
      messages.push('Market hub is not running.');
    }

    if (!doctor.demo.configured && selectedMode === 'demo') {
      messages.push('Demo mode selected, but DEMO_API_KEY/DEMO_API_SECRET are not configured.');
    }

    if (doctor.journal.sizeBytes === 0) {
      messages.push('Journal file is missing or empty.');
    }

    return messages;
  }, [doctor, selectedMode]);

  return (
    <>
      <Card className="mb-3">
        <Card.Header>Status</Card.Header>
        <Card.Body>
          <p>
            REST: <Badge bg={restHealthy ? 'success' : 'danger'}>{restHealthy ? 'Connected' : 'Disconnected'}</Badge>
          </p>
          <p>
            WS: <Badge bg={wsConnected ? 'success' : 'danger'}>{wsConnected ? 'Connected' : 'Disconnected'}</Badge>
          </p>
          <ListGroup className="mb-3">
            <ListGroup.Item>Running: {String(botState.running)}</ListGroup.Item>
            <ListGroup.Item>Paused: {String(botState.paused)}</ListGroup.Item>
            <ListGroup.Item>Mode: {botState.mode ?? '-'}</ListGroup.Item>
            <ListGroup.Item>Direction: {botState.direction ?? '-'}</ListGroup.Item>
            <ListGroup.Item>TF: {botState.tf ?? '-'}</ListGroup.Item>
            <ListGroup.Item>Queue depth: {botState.queueDepth}</ListGroup.Item>
            <ListGroup.Item>Active orders: {botState.activeOrders}</ListGroup.Item>
            <ListGroup.Item>Open positions: {botState.openPositions}</ListGroup.Item>
            <ListGroup.Item>Uptime (active): {formatDuration(botState.uptimeMs)}</ListGroup.Item>
            <ListGroup.Item>
              Snapshot: <Badge bg={botState.hasSnapshot ? 'success' : 'secondary'}>{botState.hasSnapshot ? 'hasSnapshot=true' : 'none'}</Badge>
            </ListGroup.Item>
          </ListGroup>
          <div className="d-flex gap-2 mb-3">
            <Button variant="warning" onClick={onPause} disabled={!botState.running || botState.paused}>
              Pause
            </Button>
            <Button variant="success" onClick={onResume} disabled={!botState.hasSnapshot && !botState.paused}>
              Resume
            </Button>
            <Button variant="danger" onClick={onStop} disabled={!botState.running}>
              Stop
            </Button>
          </div>
          <Link to="/bot">Go to bot controls</Link>
        </Card.Body>
      </Card>

      <Card className="mb-3">
        <Card.Header className="d-flex justify-content-between align-items-center">
          <span>Results</span>
          <Button size="sm" onClick={() => void refreshBotStats()}>
            Refresh
          </Button>
        </Card.Header>
        <Card.Body>
          <div>Total trades: {botStats.totalTrades}</div>
          <div>Wins: {botStats.wins}</div>
          <div>Losses: {botStats.losses}</div>
          <div>Winrate: {botStats.winratePct.toFixed(2)}%</div>
          <div>PnL (USDT): {botStats.pnlUSDT.toFixed(2)}</div>
          <div>Today PnL (USDT): {botStats.todayPnlUSDT.toFixed(2)}</div>
          <div>Loss streak: {botStats.lossStreak}</div>
          <div>Guardrail pause reason: {botStats.guardrailPauseReason ?? '-'}</div>
          <div>Avg win (USDT): {botStats.avgWinUSDT === null ? '-' : botStats.avgWinUSDT.toFixed(2)}</div>
          <div>Avg loss (USDT): {botStats.avgLossUSDT === null ? '-' : botStats.avgLossUSDT.toFixed(2)}</div>
          <div>
            Last closed:{' '}
            {botStats.lastClosed
              ? `${new Date(botStats.lastClosed.ts).toLocaleString()} ${botStats.lastClosed.symbol} ${botStats.lastClosed.netPnlUSDT.toFixed(2)}`
              : '-'}
          </div>
          <hr />
          <div><strong>LONG</strong> — Trades: {botStats.long.trades}, Winrate: {botStats.long.winratePct.toFixed(2)}%, PnL (USDT): {botStats.long.pnlUSDT.toFixed(2)}</div>
          <div><strong>SHORT</strong> — Trades: {botStats.short.trades}, Winrate: {botStats.short.winratePct.toFixed(2)}%, PnL (USDT): {botStats.short.pnlUSDT.toFixed(2)}</div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Header className="d-flex justify-content-between align-items-center">
          <span>Diagnostics</span>
          <Button size="sm" onClick={() => void refreshDoctor()} disabled={doctorLoading}>
            {doctorLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Card.Header>
        <Card.Body>
          {doctorError ? <Alert variant="danger">{doctorError}</Alert> : null}
          {warnings.map((warning) => (
            <Alert key={warning} variant="warning" className="py-2 mb-2">
              {warning}
            </Alert>
          ))}

          {doctor ? (
            <ListGroup>
              <ListGroup.Item>Server time: {new Date(doctor.serverTime).toLocaleString()}</ListGroup.Item>
              <ListGroup.Item>Uptime (sec): {doctor.uptimeSec}</ListGroup.Item>
              <ListGroup.Item>Version: {doctor.version}</ListGroup.Item>
              <ListGroup.Item>Universe ready: {String(doctor.universe.ready)}</ListGroup.Item>
              <ListGroup.Item>Universe symbols: {doctor.universe.symbols}</ListGroup.Item>
              <ListGroup.Item>Market running: {String(doctor.market.running)}</ListGroup.Item>
              <ListGroup.Item>Market subscribed: {doctor.market.subscribed}</ListGroup.Item>
              <ListGroup.Item>Market updates/sec: {doctor.market.updatesPerSec}</ListGroup.Item>
              <ListGroup.Item>Market tick handler avg (ms): {doctor.market.tickHandlersMsAvg}</ListGroup.Item>
              <ListGroup.Item>WS clients: {doctor.market.wsClients}</ListGroup.Item>
              <ListGroup.Item>WS frames/sec: {doctor.market.wsFramesPerSec}</ListGroup.Item>
              <ListGroup.Item>Bot running: {String(doctor.bot.running)}</ListGroup.Item>
              <ListGroup.Item>Bot paused: {String(doctor.bot.paused)}</ListGroup.Item>
              <ListGroup.Item>Bot mode: {doctor.bot.mode ?? '-'}</ListGroup.Item>
              <ListGroup.Item>Bot direction: {doctor.bot.direction ?? '-'}</ListGroup.Item>
              <ListGroup.Item>Bot tf: {doctor.bot.tf ?? '-'}</ListGroup.Item>
              <ListGroup.Item>Bot evals/sec: {doctor.bot.evalsPerSec}</ListGroup.Item>
              <ListGroup.Item>Replay recording: {String(doctor.replay.recording)}</ListGroup.Item>
              <ListGroup.Item>Replay replaying: {String(doctor.replay.replaying)}</ListGroup.Item>
              <ListGroup.Item>Replay file: {doctor.replay.fileName ?? '-'}</ListGroup.Item>
              <ListGroup.Item>Journal enabled: {String(doctor.journal.enabled)}</ListGroup.Item>
              <ListGroup.Item>Journal path: {doctor.journal.path}</ListGroup.Item>
              <ListGroup.Item>Journal size bytes: {doctor.journal.sizeBytes}</ListGroup.Item>
              <ListGroup.Item>Demo configured: {String(doctor.demo.configured)}</ListGroup.Item>
            </ListGroup>
          ) : (
            <div>Diagnostics not loaded yet.</div>
          )}
        </Card.Body>
      </Card>
    </>
  );
}

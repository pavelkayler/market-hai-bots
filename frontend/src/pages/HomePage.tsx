import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, ListGroup } from 'react-bootstrap';
import { Link } from 'react-router-dom';

import { getBotStats, getDoctor } from '../api';
import { isDoctorReport } from '../types';
import type { BotState, BotStats, DoctorCheckStatus, DoctorResponse, WsConnectionState } from '../types';
import { formatDuration } from '../utils/time';

type Props = {
  restHealthy: boolean;
  wsState?: WsConnectionState | null;
  botState: BotState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

export function HomePage({ restHealthy, wsState, botState, onPause, onResume, onStop }: Props) {
  const { ready = false, status = 'DISCONNECTED', lastError = null } = wsState ?? {};
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
    short: { trades: 0, wins: 0, losses: 0, winratePct: 0, pnlUSDT: 0 },
    reasonCounts: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
    signalsConfirmed: 0,
    signalsBySide: { long: 0, short: 0 },
    signalsByEntryReason: { LONG_CONTINUATION: 0, SHORT_CONTINUATION: 0, SHORT_DIVERGENCE: 0 },
    bothHadBothCount: 0,
    bothChosenLongCount: 0,
    bothChosenShortCount: 0,
    bothTieBreakMode: 'shortPriority',
    totalFeesUSDT: 0,
    totalSlippageUSDT: 0,
    avgSpreadBpsEntry: null,
    avgSpreadBpsExit: null,
    expectancyUSDT: null,
    profitFactor: null,
    avgFeePerTradeUSDT: null,
    avgNetPerTradeUSDT: null
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
    if (!doctor || !isDoctorReport(doctor)) {
      return [];
    }

    const checkWarnings = (doctor.checks ?? [])
      .filter((check) => check?.status && check.status !== 'PASS')
      .map((check) => `${check.status} ${check.id}: ${check.message}`);
    const reportWarnings = (doctor.warnings ?? []).filter((warning) => typeof warning === 'string');

    if (selectedMode === 'demo' && checkWarnings.length === 0 && reportWarnings.length === 0 && doctor.ok === false) {
      return ['WARN doctor report indicates degraded state while in demo mode.'];
    }

    return [...checkWarnings, ...reportWarnings];
  }, [doctor, selectedMode]);

  const checkBadgeVariant = (status: DoctorCheckStatus): 'success' | 'warning' | 'danger' => {
    if (status === 'PASS') return 'success';
    if (status === 'WARN') return 'warning';
    return 'danger';
  };

  return (
    <>
      <Card className="mb-3">
        <Card.Header>Status</Card.Header>
        <Card.Body>
          <p>
            REST: <Badge bg={restHealthy ? 'success' : 'danger'}>{restHealthy ? 'Connected' : 'Disconnected'}</Badge>
          </p>
          <p>
            WS: <Badge bg={ready ? 'success' : status === 'CONNECTING' ? 'warning' : 'danger'}>{status}</Badge>
          </p>
          {status === 'CONNECTING' ? (
            <Alert variant="info" className="py-2">
              WS connecting…
            </Alert>
          ) : null}
          {status === 'DISCONNECTED' || status === 'ERROR' ? (
            <Alert variant="warning" className="py-2">
              <div><strong>WS disconnected.</strong> Start backend at localhost:8080.</div>
              {lastError ? <div className="small text-muted mt-1">Last error: {lastError}</div> : null}
            </Alert>
          ) : null}
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
          <div><strong>Entry reasons</strong> — Long continuation: {botStats.reasonCounts.LONG_CONTINUATION}, Short continuation: {botStats.reasonCounts.SHORT_CONTINUATION}, Short divergence: {botStats.reasonCounts.SHORT_DIVERGENCE}</div>
          <div><strong>Confirmed signals</strong>: {botStats.signalsConfirmed} (Long {botStats.signalsBySide.long} / Short {botStats.signalsBySide.short})</div>
          <div><strong>By reason</strong>: LONG_CONTINUATION {botStats.signalsByEntryReason.LONG_CONTINUATION}, SHORT_CONTINUATION {botStats.signalsByEntryReason.SHORT_CONTINUATION}, SHORT_DIVERGENCE {botStats.signalsByEntryReason.SHORT_DIVERGENCE}</div>

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

          {doctor && isDoctorReport(doctor) ? (
            <ListGroup>
              <ListGroup.Item>Timestamp: {doctor.ts ? new Date(doctor.ts).toLocaleString() : '-'}</ListGroup.Item>
              <ListGroup.Item>
                Overall:{' '}
                <Badge bg={doctor.ok ? 'success' : 'danger'}>{doctor.ok ? 'OK' : 'DEGRADED'}</Badge>
              </ListGroup.Item>
              <ListGroup.Item>Version commit: {doctor.version?.commit ?? '-'}</ListGroup.Item>
              <ListGroup.Item>Version node: {doctor.version?.node ?? '-'}</ListGroup.Item>
              <ListGroup.Item>
                Checks:
                {(doctor.checks ?? []).length === 0 ? (
                  <div className="small text-muted mt-1">No checks reported.</div>
                ) : (
                  <ListGroup className="mt-2">
                    {doctor.checks.map((check) => (
                      <ListGroup.Item key={`${check.id}-${check.message}`}>
                        <Badge bg={checkBadgeVariant(check.status)} className="me-2">
                          {check.status}
                        </Badge>
                        <strong>{check.id}</strong> — {check.message}
                        {check.details ? (
                          <details className="mt-1">
                            <summary className="small">details</summary>
                            <pre className="small mb-0">{JSON.stringify(check.details, null, 2)}</pre>
                          </details>
                        ) : null}
                      </ListGroup.Item>
                    ))}
                  </ListGroup>
                )}
              </ListGroup.Item>
            </ListGroup>
          ) : doctor ? (
            <Alert variant="info" className="mb-0">
              Diagnostics payload received in legacy/unknown format.
            </Alert>
          ) : (
            <div>Diagnostics not loaded yet.</div>
          )}
        </Card.Body>
      </Card>
    </>
  );
}

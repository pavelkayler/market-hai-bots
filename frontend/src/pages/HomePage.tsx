import { Badge, Button, Card, ListGroup } from 'react-bootstrap';
import { Link } from 'react-router-dom';

import type { BotState } from '../types';

type Props = {
  restHealthy: boolean;
  wsConnected: boolean;
  botState: BotState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

export function HomePage({ restHealthy, wsConnected, botState, onPause, onResume, onStop }: Props) {
  return (
    <Card>
      <Card.Header>Status</Card.Header>
      <Card.Body>
        <p>
          REST:{' '}
          <Badge bg={restHealthy ? 'success' : 'danger'}>{restHealthy ? 'Connected' : 'Disconnected'}</Badge>
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
          <ListGroup.Item>
            Snapshot:{' '}
            <Badge bg={botState.hasSnapshot ? 'success' : 'secondary'}>{botState.hasSnapshot ? 'hasSnapshot=true' : 'none'}</Badge>
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
  );
}

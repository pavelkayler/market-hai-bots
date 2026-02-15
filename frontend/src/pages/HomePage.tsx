import { Badge, Card, ListGroup } from 'react-bootstrap';
import { Link } from 'react-router-dom';

import type { BotState } from '../types';

type Props = {
  restHealthy: boolean;
  wsConnected: boolean;
  botState: BotState;
};

export function HomePage({ restHealthy, wsConnected, botState }: Props) {
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
          <ListGroup.Item>Mode: {botState.mode ?? '-'}</ListGroup.Item>
          <ListGroup.Item>Direction: {botState.direction ?? '-'}</ListGroup.Item>
          <ListGroup.Item>TF: {botState.tf ?? '-'}</ListGroup.Item>
          <ListGroup.Item>Queue depth: {botState.queueDepth}</ListGroup.Item>
          <ListGroup.Item>Active orders: {botState.activeOrders}</ListGroup.Item>
          <ListGroup.Item>Open positions: {botState.openPositions}</ListGroup.Item>
        </ListGroup>
        <Link to="/bot">Go to bot controls</Link>
      </Card.Body>
    </Card>
  );
}

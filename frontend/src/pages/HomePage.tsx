import { Alert, Badge, Card } from 'react-bootstrap';

import type { WsConnectionState } from '../types';

type Props = {
  restHealthy: boolean;
  wsState?: WsConnectionState | null;
};

export function HomePage({ restHealthy, wsState }: Props) {
  const ready = wsState?.ready ?? false;
  const status = wsState?.status ?? 'DISCONNECTED';
  const lastError = wsState?.lastError ?? null;

  return (
    <Card className="mb-3">
      <Card.Header>Status</Card.Header>
      <Card.Body>
        <p>
          REST: <Badge bg={restHealthy ? 'success' : 'danger'}>{restHealthy ? 'Connected' : 'Disconnected'}</Badge>
        </p>
        <p>
          WS: <Badge bg={ready ? 'success' : status === 'CONNECTING' ? 'warning' : status === 'ERROR' ? 'danger' : 'secondary'}>{status}</Badge>
        </p>
        {status === 'CONNECTING' ? (
          <Alert variant="info" className="py-2 mb-0">
            WS connecting...
          </Alert>
        ) : null}
        {status === 'DISCONNECTED' ? (
          <Alert variant="warning" className="py-2 mb-0">
            WS disconnected.
          </Alert>
        ) : null}
        {status === 'ERROR' ? (
          <Alert variant="danger" className="py-2 mb-0">
            WS error{lastError ? `: ${lastError}` : '.'}
          </Alert>
        ) : null}
      </Card.Body>
    </Card>
  );
}

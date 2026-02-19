import { Badge, Card, Table } from 'react-bootstrap';

import type { BotState, WsConnectionState } from '../types';

type Props = {
  wsState: WsConnectionState;
  bybitWs: { connected: boolean; lastMessageAt: number | null; lastTickerAt: number | null; subscribedCount: number; desiredCount: number } | null;
  botState: BotState | null;
};

const fmt = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : '—');

export function HomePage({ wsState, bybitWs, botState }: Props) {
  return (
    <div className="d-grid gap-3">
      <Card><Card.Body>
        <div>Frontend ↔ Backend WS: <Badge bg={wsState.ready ? 'success' : 'danger'}>{wsState.status}</Badge></div>
        <div className="small text-muted">Last message: {fmt(wsState.lastMessageAt)}</div>
      </Card.Body></Card>

      <Card><Card.Body>
        <div>Backend ↔ Bybit WS: <Badge bg={bybitWs?.connected ? 'success' : 'danger'}>{bybitWs?.connected ? 'CONNECTED' : 'DISCONNECTED'}</Badge></div>
        <div className="small text-muted">Last message: {fmt(bybitWs?.lastMessageAt)} · Last ticker: {fmt(bybitWs?.lastTickerAt)}</div>
        <div className="small text-muted">Subscribed {bybitWs?.subscribedCount ?? 0} / desired {bybitWs?.desiredCount ?? 0}</div>
      </Card.Body></Card>

      <Card><Card.Header>Open positions</Card.Header><Card.Body>
        <Table size="sm" striped><thead><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Avg price</th><th>Unrealized PnL</th></tr></thead>
          <tbody>{(botState?.positions ?? []).map((row) => <tr key={row.symbol}><td>{row.symbol}</td><td>{row.side}</td><td>{row.size}</td><td>{row.avgPrice}</td><td>{row.unrealizedPnl}</td></tr>)}</tbody>
        </Table>
      </Card.Body></Card>

      <Card><Card.Header>Open orders</Card.Header><Card.Body>
        <Table size="sm" striped><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Limit</th><th>Status</th></tr></thead>
          <tbody>{(botState?.openOrders ?? []).map((row) => <tr key={`${row.symbol}-${row.orderId ?? row.orderLinkId ?? row.limitPrice}`}><td>{row.symbol}</td><td>{row.side}</td><td>{row.qty}</td><td>{row.limitPrice}</td><td>{row.status}</td></tr>)}</tbody>
        </Table>
      </Card.Body></Card>
    </div>
  );
}

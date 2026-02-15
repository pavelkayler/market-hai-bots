# API — REST + WS contracts (MVP)

Base URL: `http://localhost:8080`
WS: `/ws`

## REST

### Universe
- `POST /api/universe/create` `{ "minVolPct": 10 }`
- `POST /api/universe/refresh` `{ "minVolPct": 12 }`
- `GET /api/universe`
- `POST /api/universe/clear`

### Bot
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/pause`
- `POST /api/bot/resume`
  - Returns `{ "ok": false, "error": "NO_SNAPSHOT" }` if no runtime snapshot exists.
- `GET /api/bot/state`
Response shape for `/api/bot/state`:
```json
{
  "running": false,
  "paused": false,
  "hasSnapshot": false,
  "lastConfig": null,
  "mode": null,
  "direction": null,
  "tf": null,
  "queueDepth": 0,
  "activeOrders": 0,
  "openPositions": 0
}
```

### Orders
- `POST /api/orders/cancel` `{ "symbol": "BTCUSDT" }`

## WS message envelope
```json
{ "type": "state", "ts": 0, "payload": {} }
```

### Types
- `state`: `{ universeReady, running, mode, queueDepth }`
- `universe:created` / `universe:refreshed`
- `symbol:update`
- `signal:new`
- `order:update`
- `position:update`
- `queue:update`
- `log` (client keeps last 5)

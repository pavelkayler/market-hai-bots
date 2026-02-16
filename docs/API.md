# API — REST + WS contracts (MVP)

Base URL: `http://localhost:8080`
WS: `/ws`

## REST

### Universe
- `POST /api/universe/create` `{ "minVolPct": 10 }`
- `POST /api/universe/refresh` `{ "minVolPct": 12 }`
- `GET /api/universe`
- `GET /api/universe/download` (returns the persisted `UniverseState` JSON directly)
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


### Doctor
- `GET /api/doctor`
  - Response:
  ```json
  {
    "ok": true,
    "serverTime": 0,
    "uptimeSec": 0,
    "version": "0.1.0",
    "universe": { "ready": false, "symbols": 0 },
    "market": { "running": true, "subscribed": 0, "updatesPerSec": 0 },
    "bot": { "running": false, "paused": false, "mode": null, "tf": null, "direction": null },
    "replay": { "recording": false, "replaying": false, "fileName": null },
    "journal": { "enabled": true, "path": "backend/data/journal.ndjson", "sizeBytes": 0 },
    "demo": { "configured": false }
  }
  ```


### Journal
- `GET /api/journal/tail?limit=200`
  - Response: `{ "ok": true, "entries": [JournalEntry] }`
- `POST /api/journal/clear`
  - Response: `{ "ok": true }`
- `GET /api/journal/download?format=ndjson|json|csv`
  - `ndjson`: raw append-only file payload.
  - `json`: JSON array of journal entries.
  - `csv`: text/csv with columns `ts,mode,symbol,event,side,qty,price,exitPrice,pnlUSDT,detailsJson`.

Journal entry schema:
```json
{
  "ts": 0,
  "mode": "paper",
  "symbol": "BTCUSDT",
  "event": "ORDER_PLACED",
  "side": "LONG",
  "data": {}
}
```

### Replay / local recording
- `POST /api/replay/record/start` `{ "topN": 20, "fileName": "session-2026-02-15.ndjson" }`
  - Response: `{ "ok": true, "path": "backend/data/replay/<fileName>", "startedAt": 0 }`
- `POST /api/replay/record/stop`
  - Response: `{ "ok": true, "stoppedAt": 0, "recordsWritten": 12345 }`
- `POST /api/replay/start` `{ "fileName": "session-2026-02-15.ndjson", "speed": "1x" | "5x" | "20x" | "fast" }`
  - Response: `{ "ok": true, "startedAt": 0 }`
- `POST /api/replay/stop`
  - Response: `{ "ok": true, "stoppedAt": 0 }`
- `GET /api/replay/state`
  - Response:
  ```json
  {
    "recording": false,
    "replaying": false,
    "fileName": null,
    "speed": null,
    "recordsWritten": 0,
    "progress": { "read": 0, "total": 0 }
  }
  ```
- `GET /api/replay/files`
  - Response: `{ "ok": true, "files": ["session-2026-02-15.ndjson"] }`

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

## Error codes
- `DEMO_NOT_CONFIGURED`
  - Returned by `POST /api/bot/start` when `mode=demo` is requested without both `DEMO_API_KEY` and `DEMO_API_SECRET` configured.

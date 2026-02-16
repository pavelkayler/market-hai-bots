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
  - Request body behavior:
    - If request includes a `BotConfig`, that explicit config is used.
    - If request body is `null`/omitted, backend loads config from current active run profile.
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

### Profiles
- `GET /api/profiles`
  - Response: `{ "ok": true, "activeProfile": "default", "names": ["default", "aggressive"] }`
- `GET /api/profiles/:name`
  - Success: `{ "ok": true, "name": "default", "config": BotConfig }`
  - Not found: `{ "ok": false, "error": "NOT_FOUND" }`
- `POST /api/profiles/:name`
  - Body: `BotConfig` (creates or overwrites profile)
  - Response: `{ "ok": true }`
- `POST /api/profiles/:name/active`
  - Sets active profile.
  - Response: `{ "ok": true }`
- `DELETE /api/profiles/:name`
  - Deletes profile by name.
  - Default profile is protected and returns `{ "ok": false, "error": "DEFAULT_PROFILE_LOCKED" }`.
- `GET /api/profiles/download`
  - Response content type: `application/json`
  - Response body is raw profiles storage JSON:
  ```json
  {
    "activeProfile": "default",
    "profiles": {
      "default": {
        "mode": "paper",
        "direction": "both",
        "tf": 1,
        "holdSeconds": 3,
        "priceUpThrPct": 0.5,
        "oiUpThrPct": 50,
        "marginUSDT": 100,
        "leverage": 10,
        "tpRoiPct": 1,
        "slRoiPct": 0.7
      }
    }
  }
  ```
- `POST /api/profiles/upload`
  - Body: raw JSON with same shape as `GET /api/profiles/download`.
  - Merge behavior: imported profiles overwrite same-name profiles; unknown names are added.
  - Response: `{ "ok": true }`


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
    "market": { "running": true, "subscribed": 0, "updatesPerSec": 0, "tickHandlersMsAvg": 0, "wsClients": 0, "wsFramesPerSec": 0 },
    "bot": { "running": false, "paused": false, "mode": null, "tf": null, "direction": null, "evalsPerSec": 0 },
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
- `symbols:update`: `{ updates: Array<symbol:update payload> }`
- `signal:new`
- `order:update`
- `position:update`
- `queue:update`
- `log` (client keeps last 5)

## Error codes
- `DEMO_NOT_CONFIGURED`
  - Returned by `POST /api/bot/start` when `mode=demo` is requested without both `DEMO_API_KEY` and `DEMO_API_SECRET` configured.

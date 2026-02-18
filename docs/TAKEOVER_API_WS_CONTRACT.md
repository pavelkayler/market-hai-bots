# TAKEOVER_API_WS_CONTRACT

## REST contract surface (v1 audited)
Маршруты объявлены в `backend/src/server.ts`.

## Core endpoints

### Health
- `GET /health` -> `{ ok: true }`

### Profiles
- `GET /api/profiles`
- `GET /api/profiles/download`
- `POST /api/profiles/upload`
- `GET /api/profiles/:name`
- `POST /api/profiles/:name`
- `POST /api/profiles/:name/active`
- `DELETE /api/profiles/:name`

Error semantics:
- `404 NOT_FOUND`
- `400 INVALID_IMPORT`
- `400 DEFAULT_PROFILE_LOCKED`
- `400 INVALID_BOT_CONFIG`

### Bot lifecycle
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/pause`
- `POST /api/bot/resume`
- `GET /api/bot/state`
- `POST /api/bot/kill`
- `GET /api/bot/guardrails`
- `GET /api/bot/stats`
- `POST /api/bot/stats/reset`
- `POST /api/orders/cancel`

Error semantics (examples):
- `400 UNIVERSE_NOT_READY`
- `400 MARKET_HUB_NOT_RUNNING`
- `400 INVALID_BOT_CONFIG`
- `400 NO_SNAPSHOT`
- `400 DEMO_NOT_CONFIGURED` (object `{code,message}`)
- `400 INVALID_SYMBOL`

### System/reset/doctor
- `POST /api/reset/all` (STOP-only)
- `GET /api/doctor`

### Replay/record/runs/autotune
- `POST /api/replay/record/start`
- `POST /api/replay/record/stop`
- `POST /api/replay/start`
- `POST /api/replay/stop`
- `GET /api/replay/state`
- `GET /api/replay/files`
- `GET /api/runs`
- `GET /api/runs/:id/download`
- `GET /api/autotune/state`

Replay errors:
- `400 INVALID_TOP_N`
- `400 INVALID_FILE_NAME`
- `400 INVALID_SPEED`
- `400 REPLAY_BUSY`
- `400 REPLAY_REQUIRES_PAPER_MODE`

### Journal
- `GET /api/journal/tail?limit=`
- `POST /api/journal/clear`
- `GET /api/journal/download?format=ndjson|json|csv`

Errors:
- `400 INVALID_LIMIT`
- `400 INVALID_FORMAT`

### Export pack
- `GET /api/export/pack`
- Response headers:
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename=...`
  - `X-Export-Included: <comma-separated file list>`
- Guaranteed content: `meta.json`

### Universe + exclusions
- `POST /api/universe/create`
- `POST /api/universe/refresh`
- `GET /api/universe`
- `GET /api/universe/download`
- `POST /api/universe/clear`
- `GET /api/universe/exclusions`
- `POST /api/universe/exclusions/add`
- `POST /api/universe/exclusions/remove`
- `POST /api/universe/exclusions/clear`

Errors:
- `400 INVALID_MIN_VOL_PCT`
- `400 INVALID_MIN_TURNOVER`
- `400 INVALID_SYMBOL`
- `400 BOT_RUNNING`
- `400 UNIVERSE_NOT_READY`
- `404 UNIVERSE_NOT_FOUND`
- `502` structured upstream failure on create/refresh

## Payload shape policy (additive)
- Backend нормализует config/snapshot/profile payloads через `normalizeBotConfig` и default injection.
- Frontend type contracts (`frontend/src/types.ts`) допускают optional additive поля (`?`) в большинстве runtime payload blocks.
- WS envelopes унифицированы: `{ type, ts, payload }`.

## WS contract

### Endpoint
- `GET /ws` (Fastify websocket route)

### Server -> client topics
- `state`
- `symbol:update`
- `symbols:update`
- `queue:update`
- `universe:created`
- `universe:refreshed`
- `log`
- `order:update`
- `position:update`
- `signal:new`

### Envelope format
- `{ type: string, ts: number, payload: unknown }`

### Symbol update payload source of truth
- Backend: `backend/src/ws/symbolUpdateBroadcaster.ts`
- Frontend model: `frontend/src/types.ts` (`SymbolUpdatePayload`, `SymbolsUpdatePayload`)

## How to verify
1. Route inventory: `rg -n "app\.(get|post|delete|put)\(" backend/src/server.ts`.
2. Trigger negative cases for each error code with curl/Postman.
3. WS verification:
   - connect to `/ws`
   - confirm initial `state` frame on connect
   - run universe create/start; observe `state` + symbol updates.
4. Additive payload sanity:
   - ensure frontend does not hard-fail when extra fields appear (uses typed optional reads and spreads).

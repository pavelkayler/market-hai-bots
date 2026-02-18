# Frontend Contract Allowlist

## REST endpoints actually used by UI

| Method | Path | UI usage | Request payload used by UI | Response fields UI relies on (must-have) |
|---|---|---|---|---|
| GET | `/health` | App boot + 5s heartbeat | none | `ok` boolean for REST badge. |
| GET | `/api/universe` | App `syncRest`, Bot page Universe card | none | `ok`, `ready`, `symbols[]` (length used). |
| POST | `/api/universe/create` | Bot > Settings > Universe Create | `{ minVolPct:number, minTurnover:number }` | Any 2xx/4xx JSON; UI re-syncs after call. |
| POST | `/api/universe/refresh` | Bot > Settings > Universe Refresh | `{ minVolPct?:number, minTurnover?:number }` | Any 2xx/4xx JSON; UI re-syncs after call. |
| POST | `/api/universe/clear` | Bot > Settings > Universe Clear | `{}` | `ok` used implicitly via no-throw. |
| GET | `/api/bot/state` | App `syncRest`, Bot poller, initial WS fallback | none | `running`, `paused`, `uptimeMs`, `queueDepth`, `activeOrders`, `openPositions`, plus additive contract blocks `bot/config/universe/activity/symbols` consumed by tables and badges. |
| GET | `/api/bot/stats` | Bot stats panel + per-symbol results | none | `{ ok:true, stats }`; stats fields consumed directly (`totalTrades`, `wins`, `losses`, `winratePct`, `pnlUSDT`, `todayPnlUSDT`, `long`, `short`, `perSymbol[]`, etc.). |
| POST | `/api/bot/start` | Bot lifecycle Start | partial settings object | Any success or `{ error }` JSON; errors shown to operator. |
| POST | `/api/bot/stop` | Bot lifecycle Stop | `{}` | Any success or `{ error }` JSON; status banner shown. |
| POST | `/api/bot/pause` | Bot lifecycle Pause | `{}` | Any success or `{ error }` JSON; status banner shown. |
| POST | `/api/bot/kill` | Bot lifecycle KILL | `{}` | `cancelledOrders`, `closedPositions`, `warning`, `activeOrdersRemaining`, `openPositionsRemaining` (type contract). |
| POST | `/api/bot/reset` | Bot lifecycle Reset (STOP-only UI) | `{}` | `warning`, `cleared.universe`, `cleared.runtime` (type contract). |
| GET | `/api/doctor` | Doctor page | none | `checks[]` (only modern report path rendered). |

## REST endpoints exported in `frontend/src/api.ts` but not wired to UI pages

- `/api/universe/exclusions`, `/add`, `/remove`
- `/api/bot/stats/reset`
- `/api/bot/clearAllTables`
- `/api/bot/resume`
- `/api/orders/cancel`
- `/api/journal/tail`, `/api/journal/clear`
- Profile endpoints (`/api/profiles*`)

These functions exist in API helper but are not imported/used by current routed pages.

## WS message allowlist actually consumed by UI

| WS type | Required by UI | UI behavior |
|---|---|---|
| `state` | YES | Merges payload into `botState` and keeps numeric safety defaults for `queueDepth/activeOrders/openPositions`. |
| `symbol:update` | YES | Updates one row in `symbolMap`; increments local updates/sec counter. |
| `symbols:update` | YES | Batch-update `symbolMap`; increments updates/sec by batch length. |
| `queue:update` | YES | Sets `botState.queueDepth`. |
| `universe:created` | YES | Adds log line and triggers REST re-sync. |
| `universe:refreshed` | YES | Adds log line and triggers REST re-sync. |
| `log` | YES | Appends payload message to recent log lines. |
| `order:update` | Optional UX log | Logged only; no state mutation. |
| `position:update` | Optional UX log | Logged only; no state mutation. |
| `signal:new` | Optional UX log | Logged only; no state mutation. |

## WS connection behavior required by UI

- WS URL = `VITE_BACKEND_URL` converted from `http(s)` to `ws(s)` + `/ws`.
- Reconnect loop: 1.5s backoff timer after close/error/constructor failure.
- On successful open: set `CONNECTED`, clear last error, and trigger REST sync.
- WS parse failures are tolerated (logged, ignored).

## Contract-critical fields that prevent UI breakage

### `GET /api/bot/state`
- Core booleans/numbers: `running`, `paused`, `uptimeMs`, `queueDepth`, `activeOrders`, `openPositions`.
- Additive contract blocks used in rendered tables/cards:
  - `bot.phase`, `bot.running`, `bot.startedAt`, `bot.stoppedAt`.
  - `config.tfMinutes`, `config.priceUpThrPct`, `config.oiUpThrPct`, `config.minTriggerCount`, `config.maxTriggerCount`.
  - `universe.ready`, `universe.symbolsCount`, `universe.excludedCount`.
  - `activity.queueDepth`, `activity.activeOrders`, `activity.openPositions`, `activity.symbolUpdatesPerSec`, `activity.journalAgeMs`.
  - `symbols[]` rows with `symbol`, `markPrice`, `openInterestValue`, `priceDeltaPct`, `oiDeltaPct`, `fundingRate`, `nextFundingTimeMs`, `timeToFundingMs`, `tradability`, `signalCount24h`, `lastSignalAtMs`.

### `GET /api/doctor`
- `checks[]` with `id`, `status`, `message` (legacy format is fetched but ignored by UI rendering path).

## Evidence map

- API helper exports and endpoint paths: `frontend/src/api.ts`.
- WS URL and reconnect/message handling: `frontend/src/App.tsx`.
- Lifecycle + universe actions and stats consumption: `frontend/src/pages/BotPage.tsx`.
- Doctor data usage: `frontend/src/pages/DoctorPage.tsx`.
- Types contract: `frontend/src/types.ts`.

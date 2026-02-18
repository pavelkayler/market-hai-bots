# Backend Surface Inventory

## Fastify bootstrap and runtime wiring

- Entrypoint: `backend/src/index.ts` calls `buildServer()` then `listen(0.0.0.0:8080)`.
- Main registration: `backend/src/server.ts`.
- Plugins: CORS + Fastify WS.
- Runtime composition:
  - `MarketHub` (Bybit WS ticker ingestion + state cache)
  - `BotEngine` (lifecycle/FSM/paper+demo execution)
  - `UniverseService` + `UniverseExclusionsService`
  - `DoctorService`
  - `JournalService`
  - `ProfileService`
  - `ReplayService`, `RunRecorderService`, `RunHistoryService`, `RunEventsService`, `AutoTuneService`

## REST routes (full server surface)

### Health
- `GET /health`

### Profiles
- `GET /api/profiles`
- `GET /api/profiles/download`
- `POST /api/profiles/upload`
- `GET /api/profiles/:name`
- `POST /api/profiles/:name`
- `POST /api/profiles/:name/active`
- `DELETE /api/profiles/:name`

### Bot lifecycle / runtime
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/pause`
- `POST /api/bot/resume`
- `GET /api/bot/state`
- `POST /api/bot/kill`
- `POST /api/bot/reset`
- `GET /api/bot/guardrails`
- `GET /api/bot/stats`
- `POST /api/bot/stats/reset`
- `POST /api/reset/all`
- `POST /api/bot/clearAllTables` (inject alias to `/api/reset/all`)

### Doctor
- `GET /api/doctor`

### Journal
- `GET /api/journal/tail`
- `POST /api/journal/clear`
- `GET /api/journal/download`

### Orders
- `POST /api/orders/cancel`

### Universe
- `POST /api/universe/create`
- `POST /api/universe/refresh`
- `GET /api/universe/exclusions`
- `POST /api/universe/exclusions/add`
- `POST /api/universe/exclusions/remove`
- `POST /api/universe/exclusions/clear`
- `GET /api/universe`
- `GET /api/universe/download`
- `POST /api/universe/clear`

### Explicit removed/stubbed endpoints (404 + `REMOVED_IN_V2`)
- `POST /api/replay/record/start`
- `POST /api/replay/record/stop`
- `GET /api/runs`
- `GET /api/runs/summary`
- `GET /api/runs/:id/download`
- `GET /api/runs/:id/events`
- `GET /api/autotune/state`
- `GET /api/autotune/history`
- `GET /api/export/pack`

## WS surface (`/ws`)

### Handshake / initial push
- On connect: server registers socket in `wsClients`, removes on close.
- Immediately sends one envelope: `{ type:'state', ts, payload: buildBroadcastBotState() }`.

### Broadcast message types produced by backend runtime
- `state` (from `broadcastBotState()`; frequently after market updates and lifecycle actions)
- `signal:new`
- `order:update`
- `position:update`
- `queue:update`
- `log`
- `universe:created`
- `universe:refreshed`
- `symbol:update` and/or `symbols:update` via `SymbolUpdateBroadcaster` (mode configurable, default single)

### Broadcast cadence controls
- `SymbolUpdateBroadcaster` throttles per-symbol by `throttleMs`, with optional batch window (`batchWindowMs`, `batchMaxSymbols`).
- `state` pushes occur on every processed market update via `processMarketStateUpdate` plus explicit lifecycle transitions.

## Key module inventory (semantics)

### Universe
- Implemented in `backend/src/services/universeService.ts`.
- Canonical filter: `USDT_LINEAR_PERPETUAL_ONLY` contract filter and 24h metric thresholds.
- Contract filtering logic excludes non-linear, non-USDT, expiring/delivery, non-perp, non-trading.
- Persisted universe file: `data/universe.json`.
- Supports additive sanitization of older persisted shapes on load.

### Doctor
- Implemented in `backend/src/services/doctorService.ts`.
- Checks:
  - `ws_freshness` (15s threshold; can WARN on no symbols, FAIL when stale)
  - `market_age_per_symbol`
  - `lifecycle_invariants`
  - `universe_contract_filter`
- Returns additive report `{ ok, ts, version, checks, warnings? }`.

### Bot engine
- Implemented in `backend/src/bot/botEngine.ts`.
- Global lifecycle methods: `start/stop/pause/resume/killSwitch/resetRuntimeStateForAllSymbols`.
- Per-symbol FSM states: `IDLE`, `HOLDING_LONG`, `HOLDING_SHORT`, `ARMED_LONG`, `ARMED_SHORT`, `ENTRY_PENDING`, `POSITION_OPEN`.
- Invariant repair exists (`enforceStateInvariant`) to force-reset malformed symbol runtime tuples.

### Paper execution model
- Paper fee model constants in `backend/src/config/fees.ts` + `backend/src/bot/paperFees.ts`.
- Entry fill model:
  - limit from signal logic + configurable `paperEntrySlippageBps`
  - partial fill ratio from `paperPartialFillPct`.
- Exit model:
  - TP/SL price with configurable `paperExitSlippageBps`
  - net PnL = gross - fees - slippage (`computePnlBreakdown`).
- KILL path force-closes open paper positions at current mark with taker exit fee model.

### Persistence / profiles / journal
- Storage path defaults: `data/universe.json`, `data/runtime.json`, `data/profiles.json`, `data/journal.ndjson`.
- Runtime snapshot store: atomic temp-write/rename (`FileSnapshotStore`).
- Profile service seeds default + shipped presets and normalizes legacy config fields.
- Journal service append + tail + rotate-on-size.
- Universe exclusions persisted at `data/universe-exclusions.json` and mirrored legacy filename for compatibility.

## Evidence map

- Route declarations and WS route: `backend/src/server.ts`.
- Lifecycle/FSM/paper model: `backend/src/bot/botEngine.ts`.
- Universe and contract filter: `backend/src/services/universeService.ts`, `backend/src/services/universeContractFilter.ts`.
- Doctor checks: `backend/src/services/doctorService.ts`.
- Market WS and status/reconnect: `backend/src/market/marketHub.ts`, `backend/src/market/realBybitWsTickerStream.ts`.
- Persistence files: `backend/src/services/storagePaths.ts`, `backend/src/bot/snapshotStore.ts`, `backend/src/services/profileService.ts`, `backend/src/services/journalService.ts`, `backend/src/services/universeExclusionsService.ts`.

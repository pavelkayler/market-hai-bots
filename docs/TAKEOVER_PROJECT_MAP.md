# TAKEOVER_PROJECT_MAP

## Scope
Аудит v1 выполнен без изменения runtime-логики. Документ фиксирует карту модулей и ответственность по коду.

## Monorepo map

### Root
- `package.json` — orchestration scripts: `rc:check`, `rc:smoke`, dev запуск backend/frontend.
- `scripts/rc-smoke.mjs` — smoke-запуск backend/frontend на таймауте ~12s.
- `docs/*` — operator/spec/report документы.

### Backend map (`backend/src/*`)
- `server.ts` — composition root: Fastify routes, WS `/ws`, lifecycle ops (start/stop/pause/resume/kill/reset), export pack, replay/record endpoints, wiring всех сервисов.
- `bot/botEngine.ts` — runtime FSM + strategy evaluation + paper/demo execution hooks + snapshot restore + kill-switch internals.
- `bot/snapshotStore.ts` — runtime snapshot persistence (`runtime.json`) с atomic temp->rename записью.
- `services/universeService.ts` — universe build/refresh/get/clear, diagnostics, retry/error classification, persisted state normalization.
- `services/universeContractFilter.ts` — жесткий контракт фильтрации: only USDT linear perpetual.
- `services/universeSymbol.ts` — symbol normalization helper.
- `services/universeExclusionsService.ts` — exclusions persistence + snapshot copies per update.
- `services/profileService.ts` — profile CRUD, active profile, import/export, config normalization/backfill defaults.
- `services/journalService.ts` — NDJSON journaling, tail/read/clear, rotate best-effort.
- `services/runRecorderService.ts` — run meta/events/stats запись, list/download payload.
- `services/autoTuneService.ts` — persisted autotune runtime state (enabled/scope/history).
- `replay/replayService.ts` — record/replay mutually exclusive, replay speed control, live market disable/enable.
- `market/marketHub.ts` + `market/*Stream*.ts` — ticker ingest, per-symbol market state cache, listeners, subscriptions.
- `ws/symbolUpdateBroadcaster.ts` — throttled `symbol:update`/`symbols:update` WS broadcasts (single/batch/both).

### Frontend map (`frontend/src/*`)
- `App.tsx` — global WS lifecycle, state ingestion (`state`, `symbol:update`, `symbols:update`, `queue:update`) + REST sync fallback.
- `pages/BotPage.tsx` — основной операторский экран: lifecycle controls, universe/profile/settings forms, replay/record controls, phase table.
- `pages/HomePage.tsx` — high-level health/doctor/status.
- `api.ts` — typed REST client + error normalization (`ApiRequestError`).
- `types.ts` — frontend contract types for bot/universe/ws/replay/journal/doctor.

## Data directories and persisted artifacts
Фактические runtime/persistence пути формируются в backend относительно `process.cwd()`:
- `backend/data/universe.json` (universe)
- `backend/data/runtime.json` (snapshot)
- `backend/data/profiles.json` (profiles)
- `backend/data/journal.ndjson` (journal)
- `backend/data/universe_exclusions.json` + timestamp snapshots (exclusions)
- `backend/data/runs/<runId>/*` (run recorder)
- `backend/data/autotune/state.json` (autotune)
- `backend/data/replay/*.ndjson` (replay record files)

## Key responsibility boundaries
- REST contract owner: `backend/src/server.ts`.
- Strategy/FSM owner: `backend/src/bot/botEngine.ts`.
- Symbol universe invariants owner: `backend/src/services/universeContractFilter.ts` + `backend/src/services/universeService.ts`.
- Frontend contract consumer: `frontend/src/api.ts` + `frontend/src/types.ts` + `frontend/src/App.tsx`.

## How to verify
1. Запустить `npm run rc:check` и убедиться, что typecheck+tests+frontend build PASS.
2. Проверить map routes: `rg -n "app\.(get|post|delete|put)\(" backend/src/server.ts`.
3. Проверить ws topics: `rg -n "type: 'symbol:update'|type: 'symbols:update'|type: 'state'|queue:update" backend/src frontend/src`.
4. Проверить data paths: `rg -n "data/" backend/src/services backend/src/server.ts backend/src/replay backend/src/bot`.

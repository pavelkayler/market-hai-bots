# Functional Audit (PAPER-only) — Bybit USDT Linear Perpetual

## 0. Repo Index & Docs Canon

### Repo index (concise)

- Frontend: `frontend/src` (App shell, pages, API helper, contracts).
- Backend: `backend/src` (Fastify server/routes, bot engine, market WS, universe, doctor, services).
- Persistence/data paths:
  - `data/universe.json`
  - `data/runtime.json`
  - `data/profiles.json`
  - `data/journal.ndjson`
  - `data/universe-exclusions.json` (+ legacy mirror filename)
  - `data/replay/*` (present in codebase but replay APIs are removed stubs in v2 surface).
- Scripts: root `scripts/*.mjs` (`rc-smoke`, `rc-doctor`, `rc-e2e-report`, etc.).

### Docs canon observed

Canonical docs detected under `docs/` plus root `README.md`.

- High-signal docs: `README.md`, `docs/API.md`, `docs/INVARIANTS.md`, `docs/STATE.md`, `docs/RC.md`, `docs/SETTINGS_GUIDE.md`.

### Contradictions / drift

1. **Export pack + runs/autotune/replay docs drift**: docs advertise live endpoints (`/api/export/pack`, `/api/runs*`, `/api/autotune/*`, replay APIs), but server now returns `404 REMOVED_IN_V2` for these routes.
2. **FSM doc drift**: `docs/STATE.md` lists only `IDLE/HOLDING_*/ENTRY_PENDING/POSITION_OPEN`, but runtime FSM includes `ARMED_LONG` and `ARMED_SHORT`.
3. **README drift**: README still says export pack is downloadable via `/api/export/pack`, but route is a v2 removal stub.

---

## 1. Frontend Contract Allowlist

Reference: `docs/FRONTEND_CONTRACT_ALLOWLIST.md`.

### 1.1 REST contract actually used by routed UI

Used by current pages (`/`, `/bot`, `/doctor`):

- `GET /health`
- `GET /api/universe`
- `POST /api/universe/create`
- `POST /api/universe/refresh`
- `POST /api/universe/clear`
- `GET /api/bot/state`
- `GET /api/bot/stats`
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/pause`
- `POST /api/bot/kill`
- `POST /api/bot/reset`
- `GET /api/doctor`

### 1.2 WS contract actually used

Consumed message types:
- `state`, `symbol:update`, `symbols:update`, `queue:update`, `universe:created`, `universe:refreshed`, `log`.
- `order:update`, `position:update`, `signal:new` are only logged (not state-driving).

### 1.3 Must-have fields for crash-free UI

- `bot/state`: numeric counters + booleans (`running`, `paused`, `uptimeMs`, `queueDepth`, `activeOrders`, `openPositions`) and additive modern sections (`bot/config/universe/activity/symbols`).
- `doctor`: modern `checks[]` shape is required by Doctor page render path.
- WS envelope shape: `{ type, ts, payload }`.

### 1.4 Not wired to current pages (API helpers only)

Profiles, journal, exclusions, resume, reset-all alias, order-cancel are exported from `api.ts` but unused by current page routes.

---

## 2. Backend Surface Inventory

Reference: `docs/BACKEND_SURFACE_INVENTORY.md`.

### 2.1 Route inventory (what exists today)

Backend exposes health, profiles, bot lifecycle/state/stats, doctor, journal, orders, universe + exclusions. It also preserves removed compatibility stubs returning `REMOVED_IN_V2` for replay/runs/autotune/export-pack endpoints.

### 2.2 WS implementation details

- `/ws` handshake immediately pushes `type:'state'` payload.
- Symbol updates emitted through `SymbolUpdateBroadcaster` (single and/or batch modes) with throttling and optional batching.
- Additional broadcast types emitted: `signal:new`, `order:update`, `position:update`, `queue:update`, `log`, `universe:created`, `universe:refreshed`, and frequent `state` pushes.

### 2.3 Service/module behavior

- **Universe**: hard-filtered to USDT linear perpetual; excludes non-perp, expiring/delivery, non-USDT, non-linear, non-trading; metric thresholds are 24h turnover + 24h range volatility.
- **Doctor**: checks ws freshness (15s), market-age summary, lifecycle invariants, universe contract filter integrity.
- **Bot engine**: lifecycle + per-symbol FSM with invariant repair and paper/demo execution paths.
- **Paper execution**: configurable entry/exit slippage bps + partial fill ratio; maker/taker fee model and fee-inclusive net PnL math.
- **Persistence**: additive snapshot/profile compatibility patterns are present; exclusions service reads legacy `excluded` arrays and writes both current + legacy filenames.

---

## 3. Contract Map & Tails Candidates

### 3.1 Mapping matrix (routes / ws / modules)

| Surface | Used by UI | Used by internal runtime | Deprecated/Removed |
|---|---:|---:|---:|
| `GET /health` | YES | NO | NO |
| `GET /api/universe` | YES | YES | NO |
| `POST /api/universe/create` | YES | YES | NO |
| `POST /api/universe/refresh` | YES | YES | NO |
| `POST /api/universe/clear` | YES | YES | NO |
| `GET /api/bot/state` | YES | YES | NO |
| `POST /api/bot/start` | YES | YES | NO |
| `POST /api/bot/stop` | YES | YES | NO |
| `POST /api/bot/pause` | YES | YES | NO |
| `POST /api/bot/resume` | NO (button missing) | YES | NO |
| `POST /api/bot/kill` | YES | YES | NO |
| `POST /api/bot/reset` | YES | YES | NO |
| `POST /api/reset/all` | NO | YES | NO |
| `POST /api/bot/clearAllTables` | NO | YES (alias) | NO |
| `GET /api/bot/stats` | YES | YES | NO |
| `POST /api/bot/stats/reset` | NO | YES | NO |
| `GET /api/doctor` | YES | YES | NO |
| `POST /api/orders/cancel` | NO | YES | NO |
| `GET/POST exclusions` | NO (current UI) | YES | NO |
| Profiles endpoints | NO (current UI) | YES | NO |
| Journal endpoints | NO (current UI) | YES | NO |
| `/api/replay/record/*` | NO | NO | YES (`REMOVED_IN_V2`) |
| `/api/runs*` | NO | NO | YES (`REMOVED_IN_V2`) |
| `/api/autotune/*` | NO | NO | YES (`REMOVED_IN_V2`) |
| `/api/export/pack` | NO | NO | YES (`REMOVED_IN_V2`) |
| WS `state` | YES | YES | NO |
| WS `symbol:update` / `symbols:update` | YES | YES | NO |
| WS `queue:update` | YES | YES | NO |
| WS `universe:created/refreshed` | YES | YES | NO |
| WS `log` | YES | YES | NO |
| WS `order:update` / `position:update` / `signal:new` | YES (log-only) | YES | NO |

### 3.2 SAFE TAILS TO REMOVE LATER (proposal only)

- Removed v2 stubs can be candidates for a hard delete **after** confirming no external clients depend on their stable `REMOVED_IN_V2` semantics.
- Unwired frontend API helper methods are not safe to remove yet unless product confirms they are intentionally abandoned (profiles/journal/exclusions UI may return).

### 3.3 KEEP AS SHIM recommendations

Keep current `REMOVED_IN_V2` stubs for one more deprecation window because:
- docs and tests still reference old endpoints,
- this gives deterministic failure semantics to old clients.

---

## 4. Runtime State Machines

### 4.1 Global lifecycle (observed)

States: `STOPPED`, `RUNNING`, `PAUSED`.

Transitions and side effects:

- **start** (`POST /api/bot/start`)
  - Requires universe ready + market hub running.
  - Loads active profile or provided config, sets universe entries, starts bot, emits state.
- **stop** (`POST /api/bot/stop`)
  - Cancels pending orders, calls `botEngine.stop()`, writes run stats/events.
  - Leaves open positions untouched by design comment/UI copy.
- **pause** (`POST /api/bot/pause`)
  - Calls `botEngine.pause()`, emits state, journals `BOT_PAUSE`.
- **resume** (`POST /api/bot/resume`)
  - Requires snapshot + effective universe + running market hub, then `botEngine.resume(true)`.
- **kill** (`POST /api/bot/kill`)
  - Sets kill-in-progress flags, executes `killSwitch` (cancel pending + close open positions), then `botEngine.stop()`, persists result, emits state.
- **reset** (`POST /api/bot/reset`)
  - STOP-only guard (`409 BOT_RUNNING` if running/paused).
  - Executes killSwitch, stops bot, resets symbol runtime, clears universe, clears tracked symbols/broadcaster.
- **reset-all** (`POST /api/reset/all` and alias `/api/bot/clearAllTables`)
  - STOP-only guard.
  - Clears replay/journal/stats/runtime/exclusions/universe and keeps profiles.

### 4.2 Per-symbol FSM

Observed states:
- `IDLE`
- `HOLDING_LONG`, `HOLDING_SHORT`
- `ARMED_LONG`, `ARMED_SHORT`
- `ENTRY_PENDING`
- `POSITION_OPEN`

High-level triggers:
- IDLE → HOLDING_* on threshold candidate (price/OI/trend/gates and counters path).
- HOLDING_* → ARMED_* when continuation window required.
- HOLDING_* or ARMED_* → ENTRY_PENDING when confirmation succeeds and order is placed.
- ENTRY_PENDING → POSITION_OPEN on fill.
- ENTRY_PENDING → IDLE on cancel/expire.
- POSITION_OPEN → IDLE on TP/SL close or forced KILL close.

Invariants:
- `ENTRY_PENDING` requires pendingOrder and no position.
- `POSITION_OPEN` requires position.
- Signal-like states require neither order nor position.
- Violations are auto-repaired to `IDLE` with baseline reset.

### 4.3 Universe readiness / start gating

- Start is blocked when universe not ready or symbol list empty.
- Universe create/refresh both set market subscription + bot universe entries using effective (exclusions-applied) symbols.
- Universe contract filter is fixed to `USDT_LINEAR_PERPETUAL_ONLY`.

---

## 5. Verification Results + RC Checklist

Reference checklist: `docs/RC_CHECKLIST.md`.

### 5.1 Commands executed in this audit

- `npm install`
- `npm run rc:check`
- `npm run build:frontend`
- Manual backend/frontend bring-up and API smoke via `curl`.
- Browser smoke for Home page with backend offline.

### 5.2 Key verification outcomes

#### PASS
- Frontend production build passes.
- Backend server starts cleanly.
- Health, bot state, doctor, kill/reset/reset-all endpoints respond and are reproducible.
- UI Home page renders with backend offline and shows REST/WS failure status without crashing.

#### FAIL/BROKEN
- `npm run rc:check` fails due large backend test drift (67 failing tests), including expectation mismatches against current API behavior and removed v2 endpoints.
- Universe create hit upstream failure during this run (`BYBIT_BAD_RESPONSE`), so full start/pause/resume with live universe could not be completed.

### 5.3 Manual operator smoke notes (PAPER scope)

- Universe create/refresh could not be validated to ready state due upstream failure in this environment.
- Lifecycle API behavior observed with non-ready universe:
  - Start rejected (`UNIVERSE_NOT_READY`) as expected.
  - Pause endpoint currently accepts while stopped (produces paused=true + running=false state in raw endpoint response).
  - Resume rejects with `NO_SNAPSHOT`.
  - Kill/reset/reset-all succeed deterministically with zero outstanding orders/positions.

---

## 6. Bugs & Minimal Fix Plan

### P0 (safety/lifecycle/contract correctness)

0. **Implemented: TF bucket model + no-entry observability minimal readiness (price/OIV/funding/signal counter).**
   - Canonical UTC TF bucket rotation now captures previous candle closes for markPrice + openInterestValue and computes deltas from previous close (`deltaPct=((current-prevClose)/prevClose)*100`).
   - Missing previous closes explicitly block entries with deterministic reasons (`missing_prev_candle_price`, `missing_prev_candle_oiv`).
   - Signal counter deduplicates per symbol+TF bucket and emits deterministic no-trade reason contexts (thresholds/funding/counter/bucket).

1. **Implemented: funding absolute threshold gate (`minFundingAbs`) for PAPER minimal readiness.**
   - Backend config now persists additive `minFundingAbs` with default `0` and backward-compatible normalization for older profiles/snapshots.
   - Engine blocks entries when `abs(fundingRate) < minFundingAbs` (reason `funding_abs_below_min`), while preserving existing funding-sign direction gating.
   - Quick verify: set `minFundingAbs` high (e.g., `0.01`) and observe no entries + reason; then set `0` and confirm baseline behavior returns.

1. **Pause allowed while bot is STOPPED (impossible lifecycle tuple via API).**
   - Symptom: `POST /api/bot/pause` returns success even when `running=false`, resulting in `paused=true` + `running=false`.
   - Repro: call pause on fresh boot before start.
   - Suspected source: `server.ts` pause handler + `botEngine.pause()` lacking running guard.
   - Minimal fix: reject pause when not running (`409` or `400` stable error code).
   - Test: add route test for STOPPED pause rejection; assert UI lifecycle remains valid.
   - Scope: PAPER-only relevant; DEMO/REAL out-of-scope.

2. **Docs/API drift for removed endpoints causes operator/test confusion.**
   - Symptom: docs advertise export/replay/runs/autotune endpoints that are now `REMOVED_IN_V2` stubs.
   - Repro: hit documented endpoints.
   - Sources: `README.md`, `docs/API.md`, stubs in `server.ts`.
   - Minimal fix: document stubs explicitly, move legacy sections to deprecation appendix.
   - Test: docs/contract consistency review.

3. **RC test suite heavily out of sync with current backend behavior.**
   - Symptom: 67 failing tests in `npm run rc:check`.
   - Repro: run `npm run rc:check`.
   - Sources: `backend/test/botEngine.test.ts`, `backend/test/server.test.ts` expectations.
   - Minimal fix: triage and align tests to current v2 contract (or restore intended functionality where regressions are real).
   - Test: staged red→green across P0 lifecycle + core endpoints.

### P1 (accuracy/usability)

4. **Universe upstream failure path not clearly distinguishable in UI from normal not-ready startup.**
   - Symptom: operator sees generic failure text without clear retry guidance in current pages.
   - Repro: trigger universe create upstream failure.
   - Source: Bot page error rendering.
   - Fix: show `upstreamError.code/message/hint` from universe response.
   - Test: API failure fixture + UI assertion.

5. **Doctor page ignores legacy shape silently (renders empty checks).**
   - Symptom: if response is legacy body, page shows no checks and no explanatory banner.
   - Source: `DoctorPage` only sets report when `'checks' in next`.
   - Fix: explicit fallback banner “legacy doctor payload not renderable in this table”.
   - Test: mock legacy response.

6. **UI lifecycle controls do not expose Resume path.**
   - Symptom: backend has `/api/bot/resume`, but UI has Start/Stop/Pause/KILL/Reset only.
   - Source: Bot page actions.
   - Fix: add Resume button gated by paused/snapshot conditions.
   - Test: UI action + API call contract test.

### P2 (cleanup/tails)

7. **Unwired frontend API helper methods create dead surface in FE contract.**
   - Candidate set: profiles/journal/exclusions/resume/reset-all/cancel-order helpers.
   - Fix: either wire into UI or mark as intentionally unused in docs.

8. **Legacy/deprecated docs (`STATE.md`, API legacy sections) not synchronized with runtime FSM.**
   - Fix: update with ARMED states and current transition rules.

9. **Keep-shim strategy for removed endpoints needs explicit sunset date.**
   - Fix: deprecation policy doc with timeline.

10. **Replay/run services still instantiated while endpoints are removed.**
   - Not immediate removal candidate (runtime side-effects may remain), but should be reviewed for eventual extraction if truly unused.

### Priority recommendation

- First fix P0-1 (pause-in-stopped lifecycle violation) and P0-3 (test contract drift).
- Then tackle P1-4/P1-6 to improve operator clarity and lifecycle control completeness.
- Reserve P2 for controlled cleanup after contract freeze.

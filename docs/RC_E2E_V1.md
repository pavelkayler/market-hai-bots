# RC E2E v1 — Operator deterministic scenario (paper → demo)

This is the release-candidate runbook for a full operator validation pass. It is strictly ordered and intentionally conservative.

**Scope:** manual operator workflow + non-destructive verification helpers.  
**Do not skip order-dependent steps.**

---

## 1) Setup

### Actions
1. Install dependencies:
   - `npm ci`
   - `cd backend && npm ci`
   - `cd ../frontend && npm ci`
2. Configure environment (backend process):
   - `PORT=8080`
   - `FRONTEND_ORIGIN=http://localhost:5173`
   - Demo-only credentials for later demo phase:
     - `DEMO_API_KEY=<your-bybit-demo-key>`
     - `DEMO_API_SECRET=<your-bybit-demo-secret>`
3. Optional endpoint override for scripts:
   - `RC_BASE_URL=http://localhost:8080`

### Expected outcome
- Dependencies install without errors.
- Backend can resolve demo keys when switching to demo mode.

### If failing, check…
- Backend startup logs for missing/invalid env.
- `GET /api/doctor` for `filesystem_writable` and `run_recording_status` status.

---

## 2) Boot (backend + frontend)

### Actions
1. Start backend: `npm --prefix backend run dev`
2. Start frontend: `npm --prefix frontend run dev`
3. Open UI: `http://localhost:5173/bot`

### Expected outcome
- Backend healthy and serving REST on `http://localhost:8080`.
- Bot page loads with Dashboard tab.

### If failing, check…
- `GET /health`
- Browser console + backend terminal logs.

---

## 3) Pre-flight doctor checks

### Actions
1. Run: `npm run rc:doctor`
2. Run: `npm run rc:audit`
3. Run non-destructive RC snapshot: `npm run rc:e2e`

### Expected outcome
- `rc:doctor` exits `0` (no `FAIL` checks).
- `rc:audit` exits `0` (no vulnerabilities at `moderate` or higher).
- `rc:e2e` exits `0`, prints doctor checks, bot state invariants, recent runs, and manual step pointers.
- `WARN` is advisory; `FAIL` is blocking.

### If failing, check…
- `GET /api/doctor`
- `GET /api/bot/state`
- Backend logs around doctor check failures.
- `npm --prefix backend run audit:moderate` output and any accepted exceptions documented in `docs/KNOWN_RISKS_AND_TODOS.md`.

---

## 4) Universe build (minTurnover/minVolPct)

### Actions
1. In **Settings → Universe**, set `minVolPct` and optional `minTurnover`.
2. Create universe (`POST /api/universe/create`).
3. Validate with `GET /api/universe`.

### Expected outcome
- `ready=true` (either READY with symbols or BUILT_EMPTY with zero symbols).
- `contractFilter="USDT_LINEAR_PERPETUAL_ONLY"`.
- Diagnostics include exclusion counters (`nonUSDT`, `nonLinear`, `expiring`, `tickerMissing`, `thresholdFiltered`, `dataUnavailable`).

### If failing, check…
- `GET /api/universe`
- `GET /api/doctor` (`universe_contract_filter`)
- Backend logs for upstream market fetch errors.

---

## 5) Start bot in PAPER and run ≥15 minutes

### Actions
1. In **Settings → Profiles**, set active profile to one of shipped presets (for example `balanced_3m`) and click **Set Active**.
2. Start bot in paper mode (`POST /api/bot/start`).
3. Let it run at least 15 minutes.
4. Verify runtime evidence:

5. Verify profile persistence: refresh UI and restart backend, then confirm the same active profile remains selected.
   - Runs tab shows an active/new run.
   - `data/runs/<runId>/stats.json` exists.
   - Run SYSTEM tail contains `BOT_START` (`GET /api/runs/:id/events?limit=200&types=SYSTEM`).
   - Trades/positions show non-null `entryPrice`.
5. Verify signal-counter behavior:
   - `signalCounterThreshold` is applied on TF buckets (watch symbol updates and no-entry reasons before confirmation).

### Expected outcome
- Bot state is `running=true`.
- Run recorder artifacts exist and events include `BOT_START`.
- Open/closed trade accounting has finite non-null `entryPrice`.
- Counter gating increments toward threshold per TF evaluations.

### If failing, check…
- `GET /api/bot/state`
- `GET /api/bot/stats`
- `GET /api/runs/summary?limit=5`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `GET /api/journal/tail?limit=200`

---

## 6) Trigger at least one trade outcome (TP or SL)

### Actions
1. Continue paper run until at least one position closes by TP/SL.
2. Validate close data in UI + journal/events.
3. If Auto-Tune is enabled, validate latest applied change visibility.

### Expected outcome
- Closed trade includes realized PnL, fees, slippage, and close reason.
- If Auto-Tune applied: `AUTO_TUNE_APPLIED` appears in run events/journal and `/api/autotune/history`.
- Verify Auto-Tune changed at least 3 distinct parameters in a short paper session OR prove via deterministic unit test (`backend/test/autoTunePlanner.test.ts`) showing multi-parameter selection in starvation/negative-PnL branches.

### If failing, check…
- `GET /api/bot/stats`
- `GET /api/journal/tail?limit=200`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `GET /api/autotune/history?limit=20`

---

## 7) STOP / RESUME validation

### Actions
1. Stop bot (`POST /api/bot/stop`).
2. Verify STOPPED invariants.
3. Resume (`POST /api/bot/resume`).
4. Confirm new run is created with resume metadata.

### Expected outcome
- After stop: `running=false`, `paused=false`, `openPositions=0`, `activeOrders=0`.
- Resume creates a new run with `resumedFromSnapshot=true` in run meta.
- SYSTEM events include `BOT_RESUME`.

### If failing, check…
- `GET /api/bot/state`
- `GET /api/runs/summary?limit=5`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `data/runs/<runId>/meta.json`

---

## 8) KILL in PAPER

### Actions
1. Start/continue paper run and force at least one open position.
2. Execute kill (`POST /api/bot/kill`).
3. Verify run event + stats flush.

### Expected outcome
- Position(s) are closed (best effort), bot stops.
- Kill response includes residual counters and warning if non-zero.
- Run SYSTEM tail includes `BOT_KILL`.
- `stats.json` updated/flushed for the run.

### If failing, check…
- `POST /api/bot/kill` response payload (`activeOrdersRemaining`, `openPositionsRemaining`, `warning`)
- `GET /api/bot/state`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `GET /api/doctor`

---

## 9) Switch to DEMO

### Actions
1. Ensure `DEMO_API_KEY`/`DEMO_API_SECRET` are configured.
2. Start in demo mode (`POST /api/bot/start`, `mode=demo`).
3. Validate outbound payload checks by intentionally sending one invalid order config (invalid price/qty path) and ensure rejection.
4. Place a valid demo order and verify UI order/position mapping.
5. Test demo close confirmation path and verify failed close does not silently clear state.

### Expected outcome
- Invalid payloads are rejected (no silent runtime mutation).
- Valid demo order appears in orders/positions surfaces.
- Close confirmation is explicit; failures keep state visible for operator follow-up.

### If failing, check…
- `GET /api/bot/state`
- `GET /api/journal/tail?limit=200`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- Backend logs for demo client errors.

---

## 10) Clear all tables (STOP-only)

### Actions
1. Ensure bot is stopped.
2. Call `POST /api/bot/clearAllTables` (alias of `/api/reset/all`).
3. Verify runtime state cleared and persistent profiles retained.

### Expected outcome
- When running/paused: endpoint returns `409 BOT_RUNNING`.
- When stopped: runtime/journal/stats/universe/exclusions/replay cleared.
- Profiles are preserved.

### If failing, check…
- `POST /api/bot/clearAllTables`
- `GET /api/profiles`
- `GET /api/universe`
- `GET /api/universe/exclusions`

---

## 11) Export pack validation

### Actions
1. Call `GET /api/export/pack`.
2. Open zip and validate included files.

### Expected outcome
- `meta.json` always present.
- Optional artifacts are present when available: `stats.json`, `events.ndjson`, `journal.ndjson`, `runtime.json`, `doctor.json`.
- Missing optional files are documented in `meta.json.notes` (best effort).

### If failing, check…
- `GET /api/export/pack`
- Response header `X-Export-Included`
- `meta.json` contents inside zip.

---

## 12) Shutdown behavior (Ctrl+C)

### Actions
1. Start bot.
2. Send Ctrl+C to backend process.
3. Restart backend and inspect latest run artifacts.

### Expected outcome
- Best-effort terminal event (`BOT_SHUTDOWN`) recorded when possible.
- Stats flush attempted before process exit.

### If failing, check…
- Backend shutdown logs.
- `GET /api/runs/summary?limit=5`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `data/runs/<runId>/stats.json`

---

## 13) Post-run review

### Actions
1. In Runs tab, review the latest runs and SYSTEM event tails.
2. Download latest run zip from UI.
3. Run direct verification commands:
   - `curl -s "http://localhost:8080/api/runs/summary?limit=5" | jq`
   - `curl -s "http://localhost:8080/api/runs/<runId>/events?limit=200&types=SYSTEM" | jq`

### Expected outcome
- Runs summary lists latest sessions with best-effort stats/traded symbols.
- Event tail contains lifecycle milestones: `BOT_START`, `BOT_RESUME`, `BOT_STOP`, `BOT_KILL`, and optional `AUTO_TUNE_APPLIED`.
- Downloaded run zip includes `meta.json` always.

### If failing, check…
- `GET /api/runs/summary?limit=5`
- `GET /api/runs/:id/events?limit=200&types=SYSTEM`
- `GET /api/runs/:id/download`

---

## Notes
- `npm run rc:e2e` is intentionally read-only/non-destructive and should be used before and during RC execution.
- For strict gatekeeping, treat any doctor `FAIL` as release-blocking.


## v2 note
RC smoke for simplified mode only requires `/api/doctor` and `/api/bot/state` checks; run-history and autotune checks are deprecated.

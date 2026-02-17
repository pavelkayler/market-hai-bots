# QA Checklist (v1 RC hardening)

Use this for operator validation. Percent convention is always **`3 = 3%`**.


## Expected operator UI strings (must match)
- Universe states:
  - `READY · Universe ready (N symbols)`
  - `BUILT_EMPTY · Built empty (0 symbols passed filters).`
  - `UPSTREAM_ERROR · Upstream error (last build failed)`
  - `NO_UNIVERSE · No universe yet.`
  - `Last good universe is kept; download uses last good.`
- Symbol phase labels:
  - `HOLDING_*` / `ARMED_*` => signal phase (no order, no position)
  - `ENTRY_PENDING` => order phase
  - `POSITION_OPEN` => position phase
- Export UX:
  - In-flight button label: `Exporting...`

## PASS/FAIL recording format
For each section, record PASS/FAIL and short evidence in `docs/QA_REPORT_LATEST.md`:
- `Section <id>: PASS - <evidence>`
- `Section <id>: FAIL - <actual> (expected: <expected>)`

---

## A) Bot page tabs and content separation
1. Open `/bot`.
   - Expected: default selected tab is **Dashboard**.
   - Expected: no configuration form inputs, no profile CRUD buttons, and no Universe create/refresh/get/clear controls are visible on Dashboard.
2. Open **Settings** tab.
   - Expected: Profiles controls (select/save/save-as/delete/set-active/import/export), full settings panel, and Universe controls/diagnostics/symbol table are present.
3. Start bot (paper or replay), then open **Settings** tab.
   - Expected: lock banner is shown only in Settings and settings inputs are disabled (values still visible).
4. While running, switch back to **Dashboard**.
   - Expected: operator actions and live runtime panels remain available and updating.
5. Reload page after selecting each tab once.
   - Expected: selected tab restores from localStorage; default remains Dashboard if localStorage key is absent.
6. Switch tabs repeatedly while running.
   - Expected: no WS reconnect loop caused purely by tab switching.

## B) Universe create/get/refresh states
1. Open Bot page → **Settings** tab → Universe card.
2. Enter `minVolPct` and optional `minTurnover`, click **Create**.
   - On a live network with valid connectivity/credentials and typical thresholds, expect **READY · Universe ready (N symbols)** with `N > 0`.
   - If it is empty, expect **BUILT_EMPTY · Built empty (0 symbols passed filters).** and ordered buckets: `contractFilterExcluded`, `thresholdFiltered`, `tickerMissing`, `dataUnavailable`, `excluded`.
3. Click **Get**.
   - Expect same persisted `createdAt`, filters, and counts.
4. Click **Download universe.json**.
   - Expect file download succeeds when a universe has been persisted (including built-empty).
5. Build an intentionally strict universe (very high filters), click **Create**.
   - Expect **Built empty (0 symbols passed filters).**
6. Simulate upstream failure (`UNIVERSE_FORCE_UPSTREAM_ERROR=1`) then click **Refresh**.
   - Expect HTTP 502 surfaced as **UPSTREAM_ERROR · Upstream error (last build failed)** UI.
   - Expect text: **Last good universe is kept; download uses last good.**
   - Expect `Download universe.json` still succeeds.
7. Remove `UNIVERSE_FORCE_UPSTREAM_ERROR` and click **Refresh** again.
   - Expect return to ready or built-empty success state.

## C) Start → signal gating → order → position → close
1. Ensure universe exists, configure paper settings, click **Start**.
   - Expect bot state shows `running=true`.
2. Wait for a qualifying signal.
   - Expect symbol row reaches signal phase and no-entry reason clears when gates pass.
3. Confirm entry placement.
   - Expect `ENTRY_PENDING` row with side/limit/qty.
4. Confirm fill transition.
   - Expect `POSITION_OPEN` with entry/tp/sl.
5. Confirm close (TP/SL/manual scenario).
   - Expect `POSITION_CLOSED` journal entry and stats update (net PnL includes fees).

## D) Pause / Resume / Kill behavior
1. Click **Pause** while running.
   - Expect `paused=true`, snapshot available (`hasSnapshot=true`), and success alert.
2. Click **Resume**.
   - Expect bot resumes from snapshot and returns to running.
3. Click **Kill**.
   - Expect pending entries canceled; open positions are not force-closed.

## E) Ops journaling + export pack
1. Execute lifecycle ops in order: Pause → Resume → Kill → Stop → Reset All.
2. Open Journal tail.
   - Expect SYSTEM entries for `BOT_PAUSE`, `BOT_RESUME`, `BOT_KILL`, `SYSTEM_RESET_ALL`.
   - Expect each has `symbol="SYSTEM"`, `side=null`, and `data` as object.
3. Click **Export Pack (.zip)**.
   - Expect button becomes disabled and label changes to **Exporting...** while request is in-flight.
   - Expect success message includes resolved filename + included files list.
4. Open zip.
   - Expect `meta.json` always exists.
   - Expect optional files only when present: `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`.
   - If journal file existed, expect `journal.ndjson` included.
5. Open `meta.json`.
   - Expect `createdAt`, `appVersion`, `notes[]`, `paths`, and optional `counts`.
   - If files are missing, expect diagnostics in `notes[]` (partial export semantics).

## F) Reset all (STOP-only)
1. With bot running, click **Reset All**.
   - Expect failure (`BOT_RUNNING` / UI error); no reset performed.
2. Stop bot, click **Reset All** again.
   - Expect success; runtime tables are cleared.
3. Verify post-reset:
   - Runtime state, journal tail, stats, exclusions, universe, replay state are cleared.
   - Profiles are preserved.


## Pre-run smoke commands (record in QA_REPORT_LATEST)
1. Run `npm run rc:check` and record PASS/FAIL.
2. Run `npm run rc:smoke` and record PASS/FAIL plus startup/timeout log evidence.

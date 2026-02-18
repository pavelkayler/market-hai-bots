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

## C) smoke_min_1m operator smoke preset
1. Open Bot page → **Settings** tab → Profiles.
2. Click **Apply smoke_min_1m**.
   - Expect profile appears in selector and settings update to smoke values.
3. Click **Save** and then **Set Active**.
   - Expect success toasts/status; bot does not auto-start.
4. In Universe controls set `minTurnover=1000000` and `minVolPct=1`, then click **Create**.
   - Expect READY or BUILT_EMPTY according to market conditions.
5. Start bot in paper mode and observe lifecycle under active markets.
   - Expect at least one signal/order/position in a reasonable window (market-dependent).
6. After a close event (TP/SL/manual), verify stats and journal entries update.

## D) Start → signal gating → order → position → close
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

## E) Pause / Resume / Kill behavior
1. Click **Pause** while running.
   - Expect `paused=true`, snapshot available (`hasSnapshot=true`), and success alert.
2. Click **Resume**.
   - Expect bot resumes from snapshot and returns to running.
3. Click **Kill**.
   - Expect pending entries canceled; open positions are not force-closed.

## F) Ops journaling + export pack
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

## G) Reset all (STOP-only)
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

## H) Bot page tabs and dashboard composition (Task 50)
1. Open `/bot` in a fresh browser profile (no `bot:tab` in storage).
   - Expect default tab = **Dashboard**.
2. Validate tab order exactly:
   - Dashboard, Settings, Journal, Log, Per-symbol performance, Entry reasons.
3. Switch tabs and reload page.
   - Expect last selected tab restored from localStorage (`bot:tab`).
4. Dashboard checks:
   - Controls block visible.
   - Unified performance/costs/guardrails/runtime summary visible in Dashboard (no separate Results card).
   - Last events table shows max 3 rows.
   - No settings input controls are visible on Dashboard.
5. Settings checks:
   - Universe panel is full-width and appears above Settings panel.
   - Settings form appears only in Settings tab.
   - While bot is running, settings remain locked.
6. Tab content checks:
   - Journal tab contains journal table + SYSTEM-badge rows.
   - Log tab contains operator/log output block.
   - Per-symbol performance tab contains sortable per-symbol table + exclude controls.
   - Entry reasons tab contains "No entry reasons (top)" and "Top entry reasons (confirmed)" cards.
   - Replay/Recording block is absent in the UI.
7. KILL checks:
   - Trigger KILL with active order/position.
   - Expect UI to show KILL in progress, then completion.
   - Final state should report `activeOrders=0` and `openPositions=0` (or explicit warning state if upstream unreachable).

## Task 51 checks
- [ ] Select `PUMP_DUMP_2ND_TRIGGER`, verify only 2nd/3rd signal counts are eligible (1st blocked).
- [ ] Press Start and verify `data/runs/<ISO_TIMESTAMP>/meta.json` and `events.ndjson` exist.
- [ ] Pause+Resume and verify a **new** run directory is created with `resumedFromSnapshot=true` in `meta.json`.
- [ ] KILL while running and verify current run directory gets updated `stats.json` and terminal `BOT_KILL` event in `events.ndjson`.
- [ ] Auto-Tune OFF: no parameter changes applied.
- [ ] Auto-Tune ON: at most one bounded change per tuning step, change appears in journal and settings/dashboard indicator.


## Task 52 checks
- [ ] Verify `priceDeltaPct` is computed vs previous TF candle mark (UTC bucket), not run baseline.
- [ ] Verify `oiDeltaPct` is computed vs previous TF candle OI value (UTC bucket), not run baseline.
- [ ] Verify TF bucket behavior for `tf=1`, `tf=3`, and `tf=5` minute settings (UTC boundaries).
- [ ] Verify SHORT_DIVERGENCE uses OI-up candle gate (`oiCandleDeltaPct >= oiCandleThrPct`).
- [ ] Verify SHORT_CONTINUATION uses OI-down candle gate (`oiCandleDeltaPct <= -oiCandleThrPct`).
- [ ] Verify `requireOiTwoCandles=true` is sign-aware by `entryReason` (LONG_CONTINUATION/SHORT_DIVERGENCE: up; SHORT_CONTINUATION: down).



## J) Execution accounting validation (paper + demo)
1. Run paper mode until at least 1 closed trade.
   - Expected trade/journal fields are non-empty and finite: `entryPrice`, `exitPrice`, `qty`, `closeReason`, `feesUSDT`, `realizedNetPnlUSDT`.
   - Expected: `entryPrice` is never `null`/`NaN`.
2. Validate net PnL math against fields:
   - `grossPnlUSDT - feesUSDT - slippageUSDT == realizedNetPnlUSDT` (within rounding tolerance).
3. Run demo mode with one open/close cycle.
   - Expected: invalid orders (bad qty/price) are refused and journaled; local state is unchanged.
   - Expected: close state is cleared only after exchange confirmation (position size becomes zero).
4. Query `/api/bot/state`.
   - Expected: numeric fields always present as numbers (`queueDepth`, `activeOrders`, `openPositions`, `symbolUpdatesPerSec`, `journalAgeMs`).
   - Expected: `openOrders`/`positions` mapping is present (possibly empty arrays).

## I) Signal counter + entry offset verification (Task: threshold + offset)
1. Set `tf=1`, `signalCounterThreshold=2`.
   - Generate multiple qualifying signal updates within the same UTC TF bucket.
   - Expect `signalCount24h` to increment once only (dedupe per candle bucket).
2. Wait for next UTC TF bucket and trigger one more qualifying signal.
   - Expect `signalCount24h=2`, `signalConfirmed=true`, and entry gating to proceed.
3. Set `entryOffsetPct=0.01`.
   - Verify LONG entry limit uses `mark*(1-0.0001)` and SHORT uses `mark*(1+0.0001)` before tick rounding.
   - Verify paper/demo entry payloads use the tick-rounded offset price.
4. Import older profile/snapshot payloads containing `holdSeconds` only.
   - Verify loading remains successful and defaults are applied (`signalCounterThreshold=2`, `entryOffsetPct=0.01`).

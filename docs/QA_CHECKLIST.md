# QA Checklist (v1 RC hardening)

Use this for operator validation. Percent convention is always **`3 = 3%`**.


## Expected operator UI strings (must match)
- Universe states:
  - `Universe ready (N symbols)`
  - `Built empty (0 symbols passed filters).`
  - `Upstream error (last build failed)`
  - `Last good universe is kept; download uses last good.`
- Symbol phase labels:
  - `HOLDING_*` / `ARMED_*` => signal phase (no order, no position)
  - `ENTRY_PENDING` => order phase
  - `POSITION_OPEN` => position phase
- Export UX:
  - In-flight button label: `Exporting...`

## PASS/FAIL recording format
For each step, record one line in `docs/QA_REPORT.md`:
- `Section <id> - <step>: PASS - <evidence>`
- `Section <id> - <step>: FAIL - <actual> (expected: <expected>)`

---

## A) Universe create/get/refresh states
1. Open Bot page → Universe card.
2. Enter `minVolPct` and optional `minTurnover`, click **Create**.
   - On a live network with valid connectivity/credentials and typical thresholds, expect **Universe ready (N symbols)** with `N > 0`.
   - If it is empty, expect **Built empty (0 symbols passed filters).** with bucket counts visible, including `tickerMissing` when present.
3. Click **Get**.
   - Expect same persisted `createdAt`, filters, and counts.
4. Click **Download universe.json**.
   - Expect file download succeeds when a universe has been persisted.
5. Build an intentionally strict universe (very high filters), click **Create**.
   - Expect **Built empty (0 symbols passed filters).**
   - Expect filtered counters visible (`turnover/vol`, `data unavailable`, optional contract-filter).
6. Simulate upstream failure (`UNIVERSE_FORCE_UPSTREAM_ERROR=1`) then click **Refresh**.
   - Expect HTTP 502 surfaced as upstream error UI.
   - Expect text: **Last good universe is kept; download uses last good.**
   - Expect `Download universe.json` still succeeds.
7. Remove `UNIVERSE_FORCE_UPSTREAM_ERROR` and click **Refresh** again.
   - Expect return to ready or built-empty success state.

8. Fixture/mocked run: moderate thresholds with valid perps.
   - Expect **Ready (N symbols)** with `N > 0` and diagnostics totals showing `validTotal > 0`.
9. Fixture/mocked run: ticker-missing dataset.
   - Expect **Built empty** with `diagnostics.excluded.tickerMissing > 0` and `filteredOut.dataUnavailable > 0`.
10. Fixture/mocked run: all-non-perp dataset.
   - Expect **Built empty** with contract-filter buckets (`expiring/nonLinear/nonPerp`) > 0 and clear empty-state reason.

## B) Start → signal gating → order → position → close
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

## C) Pause / Resume / Kill behavior
1. Click **Pause** while running.
   - Expect `paused=true`, snapshot available (`hasSnapshot=true`), and success alert.
2. Click **Resume**.
   - Expect bot resumes from snapshot and returns to running.
3. Click **Kill**.
   - Expect pending entries canceled; open positions are not force-closed.

## D) Ops journaling + export pack
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

## E) Reset all (STOP-only)
1. With bot running, click **Reset All**.
   - Expect failure (`BOT_RUNNING` / UI error); no reset performed.
2. Stop bot, click **Reset All** again.
   - Expect success; runtime tables are cleared.
3. Verify post-reset:
   - Runtime state, journal tail, stats, exclusions, universe, replay state are cleared.
   - Profiles are preserved.

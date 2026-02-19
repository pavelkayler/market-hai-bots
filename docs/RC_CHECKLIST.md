# RC Checklist (PAPER mode audit)

## 1) Install & static checks

1. `npm install`
2. `npm run install:all`
3. `npm --prefix backend run build`
4. `npm --prefix backend run typecheck`
5. `npm --prefix backend test`
6. `npm --prefix frontend run build`
7. Optional bundled check: `npm run rc:check`

## 2) Start services

1. Backend: `npm --prefix backend run dev`
2. Frontend: `npm --prefix frontend run dev -- --host 0.0.0.0 --port 5173`
3. Open `http://localhost:5173`

## 3) UI/Operator smoke (manual)

### A. Home page resilience
- Stop backend.
- Load UI.
- Verify page still renders and shows REST down + WS error/disconnected status (no crash).

### B. Universe flow
- Start backend.
- In Bot > Settings > Universe:
  - Create universe (`minVolPct`, `minTurnover`)
  - Refresh universe
  - Clear universe
- Verify `Ready`/`Symbols` status updates and errors are meaningful when upstream unavailable.

### C. Exclusions flow (if/when UI exists or via API)
- Add exclusion.
- Remove exclusion.
- Clear exclusions.
- Verify STOP-only behavior and warnings when universe is not ready.

### D. Doctor
- Open Doctor page.
- Verify check table renders.
- If failing/warning, confirm diagnostics are actionable (freshness, lifecycle, universe filter).

### E. Lifecycle (PAPER)
- Expected path with ready universe: Start → Pause → Resume → Stop → KILL → Reset.
- Validate invariants:
  - KILL cancels pending orders + closes positions and ends stable STOPPED state.
  - Reset-all is STOP-only.
  - UI never shows impossible lifecycle states.

## 4) API smoke command snippets

- `curl -sS http://127.0.0.1:8080/health`
- `curl -sS http://127.0.0.1:8080/api/universe`
- `curl -sS http://127.0.0.1:8080/api/bot/state`
- `curl -sS http://127.0.0.1:8080/api/doctor`
- `curl -sS -X POST http://127.0.0.1:8080/api/bot/kill -H 'content-type: application/json' -d '{}'`
- `curl -sS -X POST http://127.0.0.1:8080/api/reset/all -H 'content-type: application/json' -d '{}'`

## 5) Exit criteria for this audit scope

- Frontend contract allowlist documented.
- Full backend route + WS inventory documented.
- UI-used vs backend-existing map documented.
- Verification results include exact commands + outputs + PASS/FAIL rationale.
- Bugs prioritized (P0/P1/P2) with reproduction + minimal fix approach.

### F. Minimal trigger reliability smoke (PAPER)
- Start bot with ready universe and `tf=1`.
- Case 1: set very high `priceUpThrPct`/`oiUpThrPct`; verify no entry and visible reasons (`price_delta_below_threshold`, `oiv_delta_below_threshold`, `signal_counter_below_min`, `funding_missing` as applicable).
- Case 2: set `minFundingAbs` high (e.g. `0.01`); verify no entry reason `funding_abs_below_min`.
- Case 3: set `minFundingAbs=0` and moderate thresholds; verify signal counter increments at most once per TF bucket under frequent ticks.
- Re-verify lifecycle: Pause/Resume/Stop/KILL and reset-all STOP-only behavior remains stable.

## 6) Step-1 PAPER regression checks

1. Verify `/api/profiles` does not expose legacy `default` in names and active profile is named (e.g. `balanced_1m`).
2. In Bot Settings (v2), save thresholds and start without `mode` in payload; confirm `/api/bot/state.lastConfig` reflects the same thresholds.
3. Run `POST /api/bot/kill`; confirm bot state STOPPED and `GET /api/doctor` shows `ws_freshness` as WARN (not FAIL) when no symbols are subscribed.
4. Confirm Dashboard renders Open positions/Open orders tables (empty states are acceptable).

## 7) Step-1 verification notes (partial-start + funding observability)

- **Reproduce quick-signal PAPER setup (1-3 minutes):**
  1. Create universe and start bot in PAPER with `tf=1`, tiny thresholds (`priceUpThrPct=0.001`, `oiUpThrPct=0.001`), and counter window (`minTriggerCount=2`, `maxTriggerCount=3`).
  2. Start using a partial payload (without `mode`/`direction`); backend now merges these values over the active profile baseline.
  3. Check `GET /api/bot/state` and `activeSymbolDiagnostics`:
     - Within first minute, expected transient reasons include missing previous TF candle close.
     - After the first candle boundary, deltas and signal counter should become observable when market moves.

- **Confirm funding `refreshNow` on start:**
  - On `POST /api/bot/start`, backend triggers a best-effort funding refresh for effective universe symbols before engine start.
  - Verify with logs containing `funding snapshot refresh completed` and `reason: "bot_start"`.
  - In UI/`/api/bot/state`, `fundingStatus` should move from `MISSING` to `OK` (or remain visibly explained if upstream data is unavailable).

- **Audit verification commands:**
  - `npm --prefix backend audit --audit-level=high`
  - `npm --prefix frontend audit --audit-level=high`
  - If advisories endpoint is blocked by environment/network policy, capture command output and treat as a warning (do not use `--force`).

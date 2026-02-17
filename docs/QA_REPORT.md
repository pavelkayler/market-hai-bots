# QA Report — Release Readiness (Task 32/33/34)

## Scope executed
- Universe lifecycle: create/get/refresh/clear + download payload checks.
- Bot lifecycle: start/pause/resume/stop, snapshot availability (`hasSnapshot`), `NO_SNAPSHOT` path.
- Paper deterministic flow: signal counter dedupe, entry pending via offset limit, fill, TP close, stats/journal verification.
- Reset-all behavior: STOP-only guard, runtime cleanup, profile preservation.
- Operator clarity: settings units/help consistency, definitions alignment in docs.

## Fixes applied
1. Added integration smoke assertions in backend route tests:
   - Universe download now asserted for canonical fields (`contractFilter`, canonicalized filters).
   - Dedicated pause->snapshot->resume flow test added.
   - Deterministic paper flow test added for signal dedupe, entry/fill/TP close, and stats/journal updates.
2. UI phase safety hardening:
   - Tracked symbol rendering now forces `POSITION_OPEN` when a position exists and forces `ENTRY_PENDING` when pending order exists in idle snapshots, preventing misleading HOLDING display.
3. Documentation/operator clarity:
   - Added QA checklist runbook.
   - Added settings “Definitions” section (percent convention, 24h volatility formula, ROI mapping, net PnL, UTC day boundary).
   - Updated README run instructions and root scripts clarity.
   - Added release notes.

## Remaining known limitations
- Demo close detection still depends on open-orders + position-list polling cadence.
- v1 remains deterministic math-only (no ML/autotune/optimizer).
- Replay behavior still bounded by recording quality and event density.

## Validation status
- Backend tests: pass.
- Frontend build: pass.
- No blocking runtime crash observed in automated smoke pass.

---

## QA Report — Release Readiness (Task 45 follow-up)

## Scope executed
- Re-ran the full automated backend regression suite that covers universe lifecycle, bot lifecycle/snapshot, paper close accounting, demo queue/sent cancel behavior, replay lifecycle state, and reset-all flows.
- Re-ran backend static type checks and frontend production build.
- Re-ran root convenience scripts (`npm test`, `npm run build:frontend`) to validate top-level commands still pass.

## Failures found and fixes
1. **Backend typecheck failed** due to `MarketState` payload shape drift (optional vs required quote/tick fields) and legacy metricDefinition parsing casts.
   - Fixed by normalizing `MarketState` to always include nullable quote fields and `lastTickTs`, and ensuring fallback/replay-fed market states provide those fields.
   - Fixed universe legacy `metricDefinition` coercion by introducing a safe adapter variable for old object shape before composing the string.
2. **Replay test mismatch** appeared after payload hardening.
   - Updated replay service test expectations to assert the complete canonical market state object.

## Remaining known limitations
- Manual click-by-click browser execution of every checklist step was not performed in this run; coverage relied on existing deterministic integration tests and API route tests.
- Demo close detection and replay quality still depend on polling/recording cadence (v1 design constraint).

## Validation status
- Backend tests: pass.
- Backend typecheck: pass.
- Frontend build: pass.
- Root scripts (`test`, `build:frontend`): pass.

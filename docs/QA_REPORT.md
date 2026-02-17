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

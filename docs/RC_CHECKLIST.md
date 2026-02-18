# RC Checklist (PAPER mode audit)

## 1) Install & static checks

1. `npm install`
2. `npm run backend:typecheck`
3. `npm test` (backend vitest)
4. `npm run build:frontend`
5. Optional bundled check: `npm run rc:check`

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

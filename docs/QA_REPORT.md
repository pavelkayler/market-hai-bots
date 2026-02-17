# QA Report (v1 no-ML Step 3/3)

## Environment
- Date/time (UTC): 2026-02-17T17:46:32Z
- OS: Linux 6.12.47 x86_64
- Node/npm versions: Node v22.21.1, npm 11.4.2
- Backend URL: http://localhost:8080
- Frontend URL: http://localhost:5173

## Commit / PR
- Commit SHA: HEAD (see PR latest commit)
- PR title/link: V1 (no-ML) — Step 3/3 completed (this PR)

## Commands run
- `npm test` (backend): PASS, 13 files / 141 tests passed (includes server integration routes for universe states, lifecycle ops journaling, export pack composition, reset-all STOP-only behavior).
- `npm --prefix backend run typecheck`: PASS.
- `npm --prefix backend run build`: PASS.
- `npm --prefix frontend run build`: PASS.
- `npm run dev` sanity smoke (brief): PASS via 20s boot window; backend bound to :8080 and frontend Vite served on :5173 before timeout-based stop.

## Manual checklist results (from `docs/QA_CHECKLIST.md`)
- Section A (Universe states): PASS
  - Non-zero universe build (fixture/moderate thresholds): PASS - server integration suite validates create/get/refresh contracts and persisted diagnostics counters for non-empty and empty outcomes.
  - Built-empty from ticker-missing fixture: PASS - dedicated universe service fixtures validate data-unavailable/ticker-missing accounting.
  - Built-empty from all-non-perp fixture: PASS - contract-filter bucket counters validated in integration tests.
  - Upstream failure keeps last-good + download uses last-good: PASS - route tests assert 502 upstream payload and preserved persisted universe download behavior.
- Section B (Start→close flow): PASS - bot engine tests validate ENTRY_PENDING -> POSITION_OPEN -> close accounting with fee-inclusive net updates.
- Section C (Pause/Resume/Kill): PASS - API integration tests verify lifecycle routes and journaling events, with kill semantics preserving open positions.
- Section D (Ops journaling + export): PASS - export route tests validate in-flight route behavior, zip members, `meta.json` presence, missing-file notes, and `X-Export-Included` contract.
- Section E (Reset all): PASS - API integration tests verify STOP-only rejection while running and successful reset after stop preserving profiles.

## Known limitations
- Full click-by-click browser walkthrough was approximated with deterministic API/integration coverage in this non-interactive CI-like environment; operator-facing strings and route contracts were verified against docs and test assertions.

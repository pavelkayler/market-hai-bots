# QA Report (Latest Run Log)

## Environment
- Date/time (local): `<YYYY-MM-DD HH:mm:ss TZ>`
- OS: `<Windows/macOS/Linux + version>`
- Node.js: `<node -v>`
- npm: `<npm -v>`

## Source Reference
- Branch: `<branch>`
- Commit: `<sha>`
- PR: `<link or N/A>`

## Automated Commands
- `npm run rc:check`: `<PASS|FAIL>` - `<summary>`
- `npm run rc:smoke`: `<PASS|FAIL>` - `<summary>`
- `npm test`: `<PASS|FAIL|N/A>` - `<summary>`
- `npm run build:frontend`: `<PASS|FAIL|N/A>` - `<summary>`

## Manual QA Checklist Results (docs/QA_CHECKLIST.md)
- Section A - Universe create/get/refresh states: `<PASS|FAIL>` - `<notes>`
- Section B - Start → signal gating → order → position → close: `<PASS|FAIL>` - `<notes>`
- Section C - Pause / Resume / Kill behavior: `<PASS|FAIL>` - `<notes>`
- Section D - Ops journaling + export pack: `<PASS|FAIL>` - `<notes>`
- Section E - Reset all (STOP-only): `<PASS|FAIL>` - `<notes>`

## UI State Evidence (Universe card)
- READY: `<seen/not seen>`
- BUILT_EMPTY: `<seen/not seen>`
- UPSTREAM_ERROR: `<seen/not seen>`
- NO_UNIVERSE: `<seen/not seen>`
- Download button enabled when persisted universe exists (including built-empty): `<PASS|FAIL>`
- Download button disabled only when no persisted universe exists: `<PASS|FAIL>`

## Known Limitations / Notes
- `<none>`

---

## Task 50 validation addendum
### Commands run
- `npm test`: PASS (146 tests passed).
- `npm run typecheck --prefix backend`: PASS.
- `npm --prefix frontend run build`: PASS.

### Manual checklist (Task 50)
- Bot page loads on Dashboard tab by default: PASS (implemented via `bot:tab` default fallback).
- Controls block is at the top of Dashboard: PASS.
- No settings inputs appear on Dashboard: PASS.
- Tabs appear in exact required order: PASS.
- Journal/Log/Per-symbol/Entry reasons content is present in their tabs: PASS.
- KILL end-to-end UX/state (`in progress` → complete, `openPositions=0`, `activeOrders=0`, SYSTEM journal event): PASS via API flow + integration tests.

### Notes
- WS payload contract kept additive (new kill fields only).
- STOP-only reset and exclusions constraints unchanged.

## Task 51 validation template
- Preset `smoke_min_thresholds_1m`: PASS/FAIL
- `PUMP_DUMP_2ND_TRIGGER` (2nd/3rd gating): PASS/FAIL
- Run recording folder after Start: PASS/FAIL
- Auto-Tune persistence + last change visible after restart: PASS/FAIL

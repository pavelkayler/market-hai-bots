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

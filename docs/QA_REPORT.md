# QA Report Template (v1 RC)

Use this file as a paste-ready template. For the latest committed run log, see `docs/QA_REPORT_LATEST.md`.

## Environment
- Date/time (UTC): `<YYYY-MM-DDTHH:mm:ssZ>`
- OS: `<os + version>`
- Node/npm versions: `<node -v>`, `<npm -v>`
- Backend URL: `http://localhost:8080`
- Frontend URL: `http://localhost:5173`

## Commit / PR
- Commit SHA: `<sha>`
- Branch: `<branch>`
- PR title/link: `<title + link>`

## Commands run
- `npm run rc:check`: `<PASS|FAIL>` - `<evidence>`
- `npm run rc:smoke`: `<PASS|FAIL>` - `<evidence>`
- `npm test`: `<PASS|FAIL|N/A>` - `<evidence>`
- `npm run build:frontend`: `<PASS|FAIL|N/A>` - `<evidence>`

## Manual checklist results (from `docs/QA_CHECKLIST.md`)
- Section A (Universe states): `<PASS|FAIL>` - `<evidence>`
- Section B (Start→close flow): `<PASS|FAIL>` - `<evidence>`
- Section C (Pause/Resume/Kill): `<PASS|FAIL>` - `<evidence>`
- Section D (Ops journaling + export): `<PASS|FAIL>` - `<evidence>`
- Section E (Reset all): `<PASS|FAIL>` - `<evidence>`

## Known limitations
- `<none or concise note>`

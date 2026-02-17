# QA Report Template (v1 RC hardening)

## Environment
- Date/time (UTC):
- OS:
- Node/npm versions:
- Backend URL:
- Frontend URL:

## Commit / PR
- Commit SHA:
- PR title/link:

## Commands run
- `npm test` (backend)
- `npm --prefix frontend run build`
- `npm --prefix backend run typecheck` (if used)
- `npm run dev` sanity smoke (brief)

Paste concise output summaries under each command.

## Manual checklist results (from `docs/QA_CHECKLIST.md`)
- Section A (Universe states): PASS/FAIL + evidence
  - Non-zero universe build (fixture/moderate thresholds): Expected vs Observed
  - Built-empty from ticker-missing fixture: Expected vs Observed
  - Built-empty from all-non-perp fixture: Expected vs Observed
  - Upstream failure keeps last-good + download uses last-good: Expected vs Observed
- Section B (Start→close flow): PASS/FAIL + evidence
- Section C (Pause/Resume/Kill): PASS/FAIL + evidence
- Section D (Ops journaling + export): PASS/FAIL + evidence
- Section E (Reset all): PASS/FAIL + evidence

Suggested line format:
- `Section A - step 6: PASS - Got 502 upstream error, last-known universe remained downloadable.`
- `Section D - step 3: FAIL - Export button did not disable during request (expected "Exporting...").`

## Known limitations
- List unresolved limitations only.
- For each, include impact + why acceptable for v1.

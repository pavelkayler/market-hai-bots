# Bybit OI/Price Bot — monorepo (local)

Backend must run on http://localhost:8080

## Quickstart
1. Install dependencies from repo root:
   - `npm i`
2. Start backend + frontend together:
   - `npm run dev`

## Environment setup (demo mode)
1. Copy `.env.example` to `.env`.
2. Set the demo credentials when you want to place demo REST orders:
   - `DEMO_API_KEY=...`
   - `DEMO_API_SECRET=...`
3. Keep `BYBIT_DEMO_REST=https://api-demo.bybit.com` for demo REST trading.


## Data files & export pack
Runtime data is stored under `backend/data/*`:
- `backend/data/universe.json`
- `backend/data/profiles.json`
- `backend/data/runtime.json`
- `backend/data/journal.ndjson`
- `backend/data/replay/*.ndjson`

For debugging/sharing, download a single bundle via `GET /api/export/pack`.
The ZIP includes `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`, and `meta.json`.
If any source file is missing, an empty placeholder is included and listed in `meta.json.missing`.

## Troubleshooting with Doctor
Use `GET /api/doctor` to validate local setup quickly:
- `universe.ready=false`: create universe first (`POST /api/universe/create`).
- `market.running=false`: backend market hub failed to start; restart backend and check logs.
- `demo.configured=false` with demo mode selected: add `DEMO_API_KEY` and `DEMO_API_SECRET`.
- `journal.sizeBytes=0`: no journal file yet (normal before first events) or journal path issue.

## Tuning workflow
1. Create universe (`POST /api/universe/create`) to define a tradable symbol set for the session.
2. Record ticks with replay recorder (`POST /api/replay/record/start`) while running your scenario.
3. Replay fast (`POST /api/replay/start` with `speed=fast`) to iterate quickly on behavior.
4. Adjust thresholds and risk params via run profiles (`/api/profiles/*`) and set active profile for repeatable starts.
5. Check outcomes through journal export (`GET /api/journal/download`) and compare runs.

## Codex workflow
Always instruct Codex to read:
- docs/INVARIANTS.md
- docs/SPEC.md
- docs/API.md
- docs/STATE.md
- docs/BYBIT.md

Then allowlist the exact files it may modify and require:
- git diff
- changed files list
- commands to verify
- no guessing; questions go into docs/TASKS.md

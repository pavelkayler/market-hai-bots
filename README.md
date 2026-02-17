# Bybit OI/Price Bot — monorepo (local)

Backend: `http://localhost:8080`  
Frontend: `http://localhost:5173` (Vite default)

## Run locally
1. Install dependencies at repo root:
   - `npm i`
2. Environment:
   - Copy `.env.example` to `.env` for local overrides.
   - Paper mode works without exchange credentials.
   - Demo mode requires `DEMO_API_KEY` + `DEMO_API_SECRET`.
3. Start backend only (Fastify on `http://localhost:8080`):
   - `npm --prefix backend run dev`
4. Start frontend only (Vite on `http://localhost:5173`):
   - `npm --prefix frontend run dev`
5. Start both from root:
   - `npm run dev`

Release-candidate smoke commands:
- `npm run rc:check` (backend typecheck + backend tests + frontend build)
- `npm run rc:smoke` (runs `rc:check`, boots backend/frontend for ~12s sanity start, then exits cleanly)

Useful direct checks:
- Backend tests: `npm test`
- Frontend production build: `npm --prefix frontend run build`
- Backend typecheck: `npm --prefix backend run typecheck`

## Operator docs
- Settings and formulas: `docs/SETTINGS_GUIDE.md`
- REST/WS contract and error semantics: `docs/API.md`
- Manual runbook: `docs/QA_CHECKLIST.md`
- QA report template: `docs/QA_REPORT.md`
- Latest QA run log: `docs/QA_REPORT_LATEST.md`
- Release summary: `docs/RELEASE_NOTES_v1.md`

## Environment setup (demo mode)
1. Copy `.env.example` to `.env`.
2. Set demo credentials when you want demo REST orders:
   - `DEMO_API_KEY=...`
   - `DEMO_API_SECRET=...`
3. Keep `BYBIT_DEMO_REST=https://api-demo.bybit.com` (default).
4. In UI settings:
   - `mode=demo` requires demo credentials.
   - `mode=paper` needs no exchange credentials.

## Data files & export pack
Runtime data is stored under `backend/data/*`:
- `backend/data/universe.json`
- `backend/data/profiles.json`
- `backend/data/runtime.json`
- `backend/data/journal.ndjson`
- `backend/data/replay/*.ndjson`

Download combined artifacts via `GET /api/export/pack`.
- Always includes: `meta.json`.
- Includes optional files only if present: `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`.
- Missing optional files are reported in `meta.json.notes` (partial export semantics).

## Troubleshooting with Doctor
Use `GET /api/doctor`:
- `universe.ready=false`: no persisted universe yet; create one first.
- `market.running=false`: restart backend and check logs.
- `demo.configured=false` with demo mode: add `DEMO_API_KEY` + `DEMO_API_SECRET`.
- `journal.sizeBytes=0`: no journal yet (normal before first events) or path issue.

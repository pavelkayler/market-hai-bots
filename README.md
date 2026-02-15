# Bybit OI/Price Bot — monorepo (local)

Backend must run on http://localhost:8080

## Run locally
1. Install dependencies:
   - `npm i`
   - `npm --prefix backend i`
   - `npm --prefix frontend i`
2. Start both apps:
   - `npm run dev`
3. Or run individually:
   - `npm run dev:backend`
   - `npm run dev:frontend`

Copy `.env.example` to `.env` (or package-specific env files) and fill demo credentials when using demo mode.

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

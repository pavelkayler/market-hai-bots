# OPERATOR_RUNBOOK_V1

## 0) Preconditions
- Backend up (`http://localhost:8080`), frontend up (`http://localhost:5173`).
- For demo mode: `DEMO_API_KEY`, `DEMO_API_SECRET` configured.
- Universe must be created before trading lifecycle start.

## 1) Universe operations

### Create
1. Open Bot Settings tab.
2. Set `minVolPct`, optional `minTurnover`.
3. Run create (calls `POST /api/universe/create`).

Expected:
- `ready=true` with symbols list OR `ready=true symbols=[]` (built-empty valid state).
- Diagnostics and `contractFilter=USDT_LINEAR_PERPETUAL_ONLY` present.

### Refresh
- Use refresh control (`POST /api/universe/refresh`).
- Should preserve filter defaults if omitted.

### Get/download
- `GET /api/universe` for current state.
- `GET /api/universe/download` for persisted raw universe.

### Clear
- `POST /api/universe/clear` clears universe + exclusions + tracked symbols.

## 2) Start monitoring/trading
1. Ensure universe ready and market running.
2. Use active profile or custom settings.
3. Press Start (`POST /api/bot/start`).

Expected:
- Bot state transitions to `running=true`.
- WS `state` and symbol updates flowing.
- Run recorder starts run metadata/events.

## 3) Entry/exit behavior (paper/demo)
- Paper: internal fill/position lifecycle, TP/SL closure, fee-inclusive PnL.
- Demo: order queue + exchange close/cancel calls via demo client when configured.
- Journal receives SIGNAL/ORDER/POSITION events in best-effort mode.

## 4) Pause/Resume
- Pause: `POST /api/bot/pause`, snapshot persists.
- Resume: `POST /api/bot/resume`, requires snapshot + ready universe + running market.
- Resume starts a new run-recorder session (`meta.json` + `events.ndjson`) with `resumedFromSnapshot=true` in run metadata.

## 5) Stop vs Kill

### Stop
- Graceful lifecycle stop (`POST /api/bot/stop`), no forced flatten semantics.

### Kill (flatten intent)
- `POST /api/bot/kill`:
  - cancel pending orders
  - close open positions
  - stop bot
  - write final run stats (`stats.json`) + terminal run event (`BOT_KILL`) best-effort
  - return residual counters and warning when non-zero.

## 6) Export pack
- Trigger `GET /api/export/pack`.
- Always expect `meta.json` in zip.
- Optional files included when present.
- Read `X-Export-Included` header for included artifact list.

## 7) Reset-all (STOP-only)
- Call `POST /api/reset/all` (or `POST /api/bot/clearAllTables`) only when bot stopped.
- Running/paused bot => `409 BOT_RUNNING`.
- Clears: stats/journal/runtime/exclusions/universe/replay state.

## 8) Bot page tabs (operator navigation)
- Dashboard: unified runtime + performance panel, controls, phase monitor, orders, positions.
- Settings: Universe panel (full-width) then Settings panel (full-width).
- Runs: recent run summaries with per-run SYSTEM events tail and zip download.
- Journal: journal table + limit/refresh/clear/download controls.
- Log: last logs view.
- Per-symbol performance: stats table + STOP-only exclude toggles.
- Entry reasons: top no-entry reasons + confirmed entry reason stats.



## 9) Runs (history + details)
1. Open **Runs** tab.
2. Click **Refresh** to load latest summaries (`GET /api/runs/summary?limit=50`).
3. Use **Details** on a row to open SYSTEM events tail (`GET /api/runs/:id/events?limit=200&types=SYSTEM`).
   - Shows BOT_START/RESUME/STOP/KILL, AUTO_TUNE_APPLIED, GUARDRAIL_PAUSED when present.
   - Missing or malformed events file is handled best-effort with warnings.
4. Use **Download** to export run artifacts (`GET /api/runs/:id/download`).
   - Zip contains `meta.json`, `events.ndjson`, and `stats.json` when available/valid.

## Failure modes and responses
- `UNIVERSE_NOT_READY`: recreate universe; check upstream diagnostics.
- `MARKET_HUB_NOT_RUNNING`: restart backend.
- `DEMO_NOT_CONFIGURED`: set demo credentials.
- `REPLAY_REQUIRES_PAPER_MODE`: stop bot or switch to paper.
- Kill warning residuals > 0: inspect journal + doctor + tracked symbols.

## How to verify
1. Execute `docs/QA_CHECKLIST.md` sections A-E.
2. Run smoke commands:
   - `npm run rc:check`
   - `npm run rc:smoke`
3. Validate doctor endpoint after each major operation (`GET /api/doctor`).

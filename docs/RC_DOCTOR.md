# RC Doctor Checklist

## Single command report
- Run `npm run rc:doctor`.
- Default endpoint: `http://localhost:8080/api/doctor`.
- Override endpoint with `RC_BASE_URL` (or `API_BASE_URL`).
- Exit code semantics:
  - `0`: no `FAIL` checks.
  - `1`: any `FAIL` check or endpoint unreachable.

Output includes:
- overall `ok`
- one line per check: `PASS|WARN|FAIL <id> - <message>`

## API quick checks
- `GET /api/doctor`: deterministic PASS/WARN/FAIL checks for market freshness, lifecycle invariants, run recording, filesystem writeability, and universe contract filter health.
- `GET /api/universe`: confirms contract filter remains `USDT_LINEAR_PERPETUAL_ONLY` and surface `excluded` list.
- `GET /api/bot/state`: verify lifecycle and `pauseReason` consistency.
- `GET /api/bot/stats`: verify guardrail counters/reason, accounting fields, and per-symbol stats.
- `POST /api/reset/all` or `POST /api/bot/clearAllTables`: STOP-only reset path.
- `POST /api/universe/exclusions/add|remove` + `GET /api/universe/exclusions`: STOP-only exclusions workflow.

## Invariants checklist
1. **Universe contract filter**
   - Create/refresh universe and confirm only Bybit USDT Linear Perpetual instruments are included.
2. **Percent convention**
   - Validate `%` inputs like `priceUpThrPct=0.5`, `entryOffsetPct=0.01`, `tpRoiPct=1` are interpreted as percent values.
3. **TF UTC bucket + dedupe**
   - Confirm evaluation occurs on UTC TF boundaries.
   - Confirm `signalCounterThreshold` dedupe behavior (`SIGNAL_COUNTER_NOT_MET` before threshold).
4. **Entry offset checks**
   - Verify `entryOffsetPct` remains additive and reflected in entry payload / accounting.
5. **Paper + demo accounting checks**
   - Closed trade payload includes gross/fees/net; `entryPrice` must never be null on open positions.
6. **Guardrail deterministic pause**
   - Trigger `dailyLossLimitUSDT` or `maxConsecutiveLosses`; bot becomes paused, `pauseReason` set, new entries blocked, run/journal record `GUARDRAIL_PAUSED`.
7. **Auto-Tune run recording + persistence**
   - `AUTO_TUNE_APPLIED` appears in runs/journal.
   - `UNIVERSE_ONLY` updates exclusions list only (no mid-run universe mutation API bypass).
8. **KILL demo confirmation**
   - Use `POST /api/bot/kill`; verify response warns when anything remains and does not report false success.
9. **Export pack best-effort**
   - Download run pack and confirm `meta.json` always present, optional files (`events.ndjson`, `stats.json`, `journal.ndjson`, `runtime.json`) included when available.
10. **Reset + clear-all STOP-only**
   - While running/paused: `POST /api/reset/all` and `POST /api/bot/clearAllTables` return `BOT_RUNNING` conflict.
   - While stopped: runtime/journal/stats/universe/exclusions/replay clear; profiles remain.
11. **Universe exclusions persistence**
   - STOP bot, add exclusion; verify `backend/data/universe-exclusions.json` updated and timestamp snapshot `backend/data/universe-exclusions-YYYYMMDD-HHMMSS.json` created.
   - Recreate/refresh universe and confirm excluded symbol remains out of effective tracked set.

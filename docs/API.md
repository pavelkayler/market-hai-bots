# API — REST + WS contracts (v1)

Base URL: `http://localhost:8080`  
WS: `/ws`

Percent convention: **`3` means `3%`** (not `0.03`).

## Universe
- `POST /api/universe/create` `{ "minVolPct": 10, "minTurnover": 10000000 }`
- `POST /api/universe/refresh` `{ "minVolPct"?: number, "minTurnover"?: number }`
- `GET /api/universe`
- `GET /api/universe/download`
- `POST /api/universe/clear`

### Universe metric definition (canonical)
`vol24hRangePct = (high24h - low24h) / low24h * 100` using Bybit 24h ticker fields (`highPrice24h`, `lowPrice24h`).

### Universe result semantics
- `ready=true` means build completed successfully, even when `symbols=[]`.
- Distinguish states clearly:
  - **No universe yet**: no persisted `createdAt`; download returns `404 UNIVERSE_NOT_FOUND`.
  - **Built empty**: persisted universe exists with `ready=true`, `symbols=[]`.
  - **Upstream failure**: create/refresh returns HTTP 502 with `upstreamError`; last good universe remains persisted and downloadable.
- 502 payload includes additive fields:
  - `diagnostics.upstreamStatus="error"`
  - `diagnostics.upstreamError { code, message, hint, retryable }`
  - `lastKnownUniverseAvailable`

- Universe diagnostics now include additive breakdown fields on create/refresh/get payloads and persisted `universe.json`:
  - `diagnostics.totals { instrumentsTotal, tickersTotal, matchedTotal, validTotal }`
  - `diagnostics.excluded { nonPerp, expiring, nonLinear, nonTrading, nonUSDT, tickerMissing, thresholdFiltered, parseError, unknown }`
  - Legacy additive fields remain (`filteredOut`, `diagnostics.byMetricThreshold`, `diagnostics.dataUnavailable`).

## Bot lifecycle
- `POST /api/bot/start`
- `POST /api/bot/stop`
- `POST /api/bot/pause`
- `POST /api/bot/resume`
- `POST /api/bot/kill`
- `GET /api/bot/state`
- `GET /api/bot/stats`
- `POST /api/bot/stats/reset`
- `POST /api/reset/all`

### Lifecycle + invariants
- Active symbols are only `ENTRY_PENDING` or `POSITION_OPEN`.
- Pause/resume/kill/reset/export append SYSTEM ops events with:
  - `symbol="SYSTEM"`
  - `side=null`
  - `data` as object
- Ops journaling is best-effort (warn-only on append failure).
- `POST /api/reset/all` is **STOP-only** (`BOT_RUNNING` when running) and preserves profiles while clearing runtime/journal/stats/universe/exclusions/replay state.

## Execution math (v1)
- `notional = marginUSDT * leverage`
- ROI to price move: `roiPct / leverage / 100`
- LONG: `tp=entry*(1+tpMovePct)`, `sl=entry*(1-slMovePct)`
- SHORT: `tp=entry*(1-tpMovePct)`, `sl=entry*(1+slMovePct)`
- Net PnL is fee-inclusive (`gross - fees`).

## Journal
- `GET /api/journal/tail?limit=200`
- `POST /api/journal/clear`
- `GET /api/journal/download?format=ndjson|json|csv`

Journal entry shape:
```json
{ "ts": 0, "mode": "paper", "symbol": "BTCUSDT", "event": "ORDER_PLACED", "side": "LONG", "data": {} }
```

## Export pack
- `GET /api/export/pack`
- Response: `application/zip`, filename `export-pack_<timestamp>.zip`
- Additive response header: `X-Export-Included` (comma-separated file members actually included in this export)
- Always includes: `meta.json`
- Optional files included only when present: `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`
- Missing optional files do not fail export; they are listed in `meta.json.notes`
- `meta.json` includes `createdAt`, `appVersion`, `notes[]`, `paths`, optional `counts`

## Replay
- `POST /api/replay/record/start`
- `POST /api/replay/record/stop`
- `POST /api/replay/start`
- `POST /api/replay/stop`
- `GET /api/replay/state`
- `GET /api/replay/files`

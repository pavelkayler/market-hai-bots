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
- Distinguish states clearly (frontend state banner mapping):
  - **NO_UNIVERSE**: no persisted file (`GET /api/universe` returns `ok=false`, `ready=false`, `lastKnownUniverseAvailable=false`); download returns `404 UNIVERSE_NOT_FOUND`.
  - **BUILT_EMPTY**: persisted universe exists with `ready=true`, `symbols=[]`.
  - **READY**: persisted universe exists with `ready=true`, `symbols.length > 0`.
  - **UPSTREAM_ERROR**: create/refresh returns HTTP 502 with `upstreamError`; last good universe remains persisted and downloadable when `lastKnownUniverseAvailable=true`.
- 502 payload includes additive fields:
  - `diagnostics.upstreamStatus="error"`
  - `diagnostics.upstreamError { code, message, hint, retryable }`
  - `lastKnownUniverseAvailable`
- Download behavior: `GET /api/universe/download` is enabled whenever a persisted universe exists (including built-empty). It is unavailable only when no persisted universe exists.

- Universe diagnostics now include additive breakdown fields on create/refresh/get payloads and persisted `universe.json`:
  - `diagnostics.totals { instrumentsTotal, tickersTotal, matchedTotal, validTotal }`
  - `diagnostics.excluded { nonPerp, expiring, nonLinear, nonTrading, nonUSDT, tickerMissing, thresholdFiltered, parseError, unknown }`
  - Legacy additive fields remain (`filteredOut`, `diagnostics.byMetricThreshold`, `diagnostics.dataUnavailable`).
- Contract eligibility is **USDT linear perpetual only**:
  - `category` must be `linear` (case-insensitive).
  - `settleCoin=USDT` and `quoteCoin=USDT` (case-insensitive).
  - `status` must be trading when present.
  - Expiring futures are excluded when `deliveryTime` parses to non-zero, or `contractType` contains `FUTURES`/`DELIVERY`, or symbol looks like dated futures (for example `BTCUSDT-26JUN26`).
  - Perpetuals are accepted when `deliveryTime` is absent/empty/zero and `contractType` is empty or contains `PERPETUAL`.
- `diagnostics.excluded.tickerMissing` is reported explicitly; legacy `filteredOut.dataUnavailable` remains a rolled-up additive count (`tickerMissing + parseError`).

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
- `POST /api/bot/clearAllTables` (alias of reset-all)

### Lifecycle + invariants
- Active symbols are only `ENTRY_PENDING` or `POSITION_OPEN`.
- Pause/resume/kill/reset/export append SYSTEM ops events with:
  - `symbol="SYSTEM"`
  - `side=null`
  - `data` as object
- Ops journaling is best-effort (warn-only on append failure).
- `POST /api/reset/all`
- `POST /api/bot/clearAllTables` (alias of reset-all) is **STOP-only** (`BOT_RUNNING` when running) and preserves profiles while clearing runtime/journal/stats/universe/exclusions/replay state.

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

### `/api/bot/state` additive kill lifecycle fields
`GET /api/bot/state` now includes additive fields for kill-progress visibility:
- `killInProgress: boolean`
- `killCompletedAt: number | null` (epoch ms)
- `killWarning: string | null`

### `POST /api/bot/kill` response
Kill response includes deterministic close/cancel outcome fields:
```json
{
  "ok": true,
  "cancelledOrders": 0,
  "closedPositions": 0,
  "activeOrdersRemaining": 0,
  "openPositionsRemaining": 0,
  "warning": null
}
```
- `warning` is populated when bounded best-effort cleanup cannot fully confirm closure/cancellation.

## Task 51 additive API
- `GET /api/runs?limit=N` lists latest run folders.
- `GET /api/runs/:id/download` downloads a single run as zip.
- `GET /api/autotune/state` returns persistent Auto-Tune state (`enabled`, `scope`, `lastApplied`, history tail).
- `GET /api/runs/:id/events?limit=200&types=SYSTEM` returns best-effort parsed run event tail (most-recent-first).
- `GET /api/autotune/history?limit=100` returns latest applied auto-tune changes for operator transparency.
- `symbol:update` WS payload now additively includes:
  - `signalCounterMin`, `signalCounterMax`, `signalCounterEligible`.


### `GET /api/runs/:id/events`
Best-effort run event tail reader from `data/runs/<id>/events.ndjson`.
- Query: `limit` (default 200), `types` (comma-separated, optional).
- Missing file or malformed lines do **not** fail request.
- Response shape:
```json
{
  "ok": true,
  "runId": "2026-01-01T00-00-00.000Z",
  "events": [
    { "ts": 1735689600000, "type": "SYSTEM", "event": "BOT_STOP" }
  ],
  "warnings": ["events.ndjson line parse failed"]
}
```

### `GET /api/autotune/history`
Read-only operator view of applied auto-tune changes recorded by Auto-Tune service.
- Query: `limit` (default 100).
- Response shape:
```json
{
  "ok": true,
  "items": [
    {
      "ts": 1735689600000,
      "parameter": "signalCounterThreshold",
      "before": 2,
      "after": 3,
      "reason": "Recent run under-trading"
    }
  ]
}
```

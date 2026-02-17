# Release Notes v1

## Highlights
- Paper + demo execution modes with TP/SL lifecycle and journaled events.
- Fee-inclusive net PnL accounting (gross - fees) across totals, side buckets, and per-symbol stats.
- ROI% to price-move conversion uses `roiPct/leverage/100`.
- Snapshot persistence (`runtime.json`) with pause/resume and crash-safe restore.
- Universe builder for USDT linear perpetual symbols only, with turnover/volatility filtering and lot-size metadata.
- Replay record/replay controls with progress and stop/restore behavior.
- Guardrails: daily loss limit, max consecutive losses, max active symbols, and kill switch.
- Signal confirmation via rolling 24h `signalCounterThreshold` with per-UTC-candle dedupe.
- Operator diagnostics: phase monitor, no-entry reason codes, reason counters, exclusions persistence.
- Universe empty-build semantics clarified: build can be `ready=true` with `symbols=[]`, with persisted filter/counter diagnostics and downloadable `universe.json`.
- Universe create/refresh reliability hardening: bounded retries + timeout classification (`BYBIT_UNREACHABLE`, `TIMEOUT`, `BYBIT_AUTH_ERROR`, `UPSTREAM_RATE_LIMIT`, parse/bad-response), plus "last good universe preserved" behavior on upstream failure.
- Universe diagnostics upgraded with contract/ticker/threshold buckets and instrument↔ticker match totals (`instrumentsTotal`, `tickersTotal`, `matchedTotal`, `validTotal`) persisted in `universe.json` for restart-safe debugging.
- Compact operator layout pass: denser card/table spacing with unchanged controls/help text.

## Invariants
- Percent inputs follow: `3` means `3%`.
- Active symbols are only `ENTRY_PENDING` or `POSITION_OPEN`.
- Reset-all is STOP-only and preserves profiles.
- Today PnL uses UTC day boundaries.
- Export pack always contains `meta.json`; other files are included only when present (`universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`).

## Known limitations
- No ML/autotune/optimizer in v1 (math-only deterministic rules).
- Microstructure/slippage modeling is simplified.
- Demo close detection depends on polling cadence for open orders and positions.
- Replay outcomes depend on recorded data quality and temporal density.


## Recommended runs
- **2-hour smoke**: `fast_test_1m` + guardrails ON.
- **Overnight**: `overnight_1m_safe` + conservative `maxActiveSymbols` + `dailyLossLimitUSDT`.


## Operational safety & export
- Lifecycle ops journaling is best-effort: pause/resume/kill/reset/export routes still succeed if journal append fails (warn-only logging).
- Export pack is partial-by-design: `meta.json` is always present, optional files are included only when found, and missing files are listed in `meta.json.notes`.
- Upstream universe failures return structured 502 payloads while preserving the last good persisted universe for download.

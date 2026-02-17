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

## Invariants
- Percent inputs follow: `3` means `3%`.
- Active symbols are only `ENTRY_PENDING` or `POSITION_OPEN`.
- Reset-all is STOP-only and preserves profiles.
- Today PnL uses UTC day boundaries.
- Export pack contains `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`, `meta.json`.

## Known limitations
- No ML/autotune/optimizer in v1 (math-only deterministic rules).
- Microstructure/slippage modeling is simplified.
- Demo close detection depends on polling cadence for open orders and positions.
- Replay outcomes depend on recorded data quality and temporal density.

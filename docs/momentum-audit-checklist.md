# Momentum Bot Audit Checklist

## 9.6 Demo/real actual fill price capture — PASS
- Entry flow now persists `entryOrderId`, `entryPriceActual`, `entryQtyActual`, `entryFillTs` in instance state and SQLite row.
- Added bounded post-fill sync (order -> executions -> position fallback), timeout logs `FILL_SYNC_TIMEOUT` without crashing.

## 11.3 Demo/real TP/SL lifecycle clarity — PASS
- Entry flow keeps explicit lifecycle fields: `tpPrice`, `slPrice`, `tpOrderId`, `slOrderId`, `tpSlStatus`.
- Added bounded TP/SL attach sync on open orders; final status transitions to `ATTACHED` or `UNKNOWN` with `TPSL_SYNC_TIMEOUT` log.

## 12.1 Isolated margin preflight on start — PASS
- Manager start now runs explicit isolated preflight (`ensureIsolatedPreflight`) in demo/real mode.
- Instance exposes `marginModeDesired=ISOLATED`, `isolatedPreflightOk`, `isolatedPreflightError` to UI.
- First-trade per-symbol isolated enforcement remains and is cached.

## 14.2 Explicit NOT_READY skip classification — PASS
- Added explicit skip classes with throttled log emission:
  - `NOT_READY_NO_PRICE_HISTORY`
  - `NOT_READY_NO_OI_HISTORY`
  - `NOT_READY_NO_TURNOVER_MEDIAN`
  - `NOT_READY_WS_DISCONNECTED`
- `NO_PREV_CANDLE` retained for turnover previous-candle absence.

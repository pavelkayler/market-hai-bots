# SETTINGS GUIDE — practical v1 reference (PAPER/DEMO)

Percent convention: **`3` means 3%** (not `0.03`).

## v1 execution math (paper)

- `notional = marginUSDT * leverage`
- Entry qty: `qty = notional / entryPrice` (then lot-size normalization)
- `entryOffsetPct` is applied first (entry limit), then TP/SL are derived from that entry price.
- ROI→price mapping:
  - `tpMovePct = tpRoiPct / leverage / 100`
  - `slMovePct = slRoiPct / leverage / 100`
  - LONG: `tp=entry*(1+tpMovePct)`, `sl=entry*(1-slMovePct)`
  - SHORT: `tp=entry*(1-tpMovePct)`, `sl=entry*(1+slMovePct)`
  - Guardrail: `tpRoiPct` and `slRoiPct` must be strictly positive.

## Paper fill model

- ENTRY limit fill:
  - LONG fills on `mark <= limit`
  - SHORT fills on `mark >= limit`
- Exit fill:
  - LONG TP `mark >= tp`, SL `mark <= sl`
  - SHORT TP `mark <= tp`, SL `mark >= sl`
- If TP and SL are both crossed in the same update, **SL priority** is used (conservative deterministic rule).

## Fees and PnL

Fees are charged on both legs:
- `entryFee = entryFeeRate * qty * entryPrice`
- `exitFee = exitFeeRate * qty * exitPrice`
- `feeTotal = entryFee + exitFee`

PAPER assumptions used in engine:
- Entry limit fill => **maker fee rate**.
- TP close => **taker fee rate**.
- SL close => **taker fee rate**.
This is intentionally conservative so paper performance is not overstated.

PnL:
- LONG gross: `(exit - entry) * qty`
- SHORT gross: `(entry - exit) * qty`
- `netPnlUSDT = grossPnlUSDT - feeTotalUSDT`

Stats and per-symbol performance use **net** PnL.

## Trend / confirmation hardening (Task 29)

- `trendTfMinutes`: `5 | 15` higher-TF context source.
- `trendLookbackBars`: lookback bars on trend TF (default `20`).
- `trendMinMovePct`: min move over lookback for trend regime (`UP`, `DOWN`, `FLAT`).
  - LONG is blocked only when trend is `DOWN`.
  - SHORT is blocked only when trend is `UP`.
  - `FLAT` allows both sides.
- `confirmWindowBars`: continuation window after trigger (`1..5`).
- `confirmMinContinuationPct`: required continuation from trigger mark.
- `impulseMaxAgeBars`: rejects stale impulses that survive too long without follow-through.
- `requireOiTwoCandles`: requires last 2 OI candle deltas to be >= `oiCandleThrPct` (for both LONG and SHORT divergence mode OI-rising checks).
- `maxSecondsIntoCandle`: keeps very-late impulse triggers out (especially on 1m).
- `minNotionalUSDT`: block tiny entries in paper/demo.
- `minSpreadBps`: optional spread gate placeholder (keep `0` when spread is unavailable).

### Example presets

- **fast_test_1m**
  - `trendTfMinutes=5`, `trendMinMovePct=0.1`, `confirmWindowBars=1`, `confirmMinContinuationPct=0.05`, `impulseMaxAgeBars=2`, `requireOiTwoCandles=false`
- **overnight_1m_safe**
  - `trendTfMinutes=15`, `trendMinMovePct=0.3`, `confirmWindowBars=2`, `confirmMinContinuationPct=0.1`, `impulseMaxAgeBars=2`, `requireOiTwoCandles=true`

## Guardrails defaults (default profile)

- `maxActiveSymbols = 3`
- `maxConsecutiveLosses = 3`
- `dailyLossLimitUSDT = 10`

Starter profiles auto-seeded on first run (when profiles file is absent):
- `default`
- `fast_test_1m`
- `overnight_1m_safe`

## Troubleshooting

### “Winrate is positive but PnL is negative”

Most common causes:
1. Fees on both legs (especially high turnover)
2. Avg loss bigger than avg win
3. SL-priority in gap-like discrete ticks (conservative close)
4. Overly tight TP/SL with high leverage

### “No entries happening”

Check WS `symbol:update.topReasons` and bot logs:
- `TREND_BLOCK_LONG` / `TREND_BLOCK_SHORT`
- `SIGNAL_COUNTER_NOT_MET`
- `NO_CONTINUATION`
- `IMPULSE_STALE` / `IMPULSE_TOO_LATE`
- `OI_2CANDLES_FAIL`
- `QTY_BELOW_MIN`
- `MAX_ACTIVE_REACHED`
- `GUARDRAIL_PAUSED`

## Operator QA checklist (Task 26)

1. Build universe with `minTurnover`/`minVolPct`.
2. Start `fast_test_1m`, verify `ARMED -> ENTRY_PENDING -> POSITION_OPEN` cycles (replay/live).
3. Confirm net vs gross in close audit fields (`grossPnlUSDT`, `feeTotalUSDT`, `netPnlUSDT`).
4. Confirm top no-entry reasons include current value + threshold.
5. Verify trend mismatch blocks entries.
6. Verify guardrail auto-pause reason in stats.
7. Verify snapshot pause/resume keeps open-position monitoring and active-only uptime accounting.


## Numeric example (why positive winrate can still be negative net)

Given `entry=100`, `qty=1`, `tp=101`, `sl=99`, `maker=0.02%`, `taker=0.055%`:
- Win gross: `+1.0000`
- Win fees: `100*0.0002 + 101*0.00055 = 0.07555`
- Win net: `+0.92445`

- Loss gross: `-1.0000`
- Loss fees: `100*0.0002 + 99*0.00055 = 0.07445`
- Loss net: `-1.07445`

With these settings, a 50% winrate is still net negative because the loss magnitude and fees outweigh the average win.

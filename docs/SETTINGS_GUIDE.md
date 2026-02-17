# SETTINGS GUIDE — practical v1 reference (PAPER/DEMO)

Percent convention: **`3` means 3%** (not `0.03`).

## Definitions (operator quick reference)

- **Percent inputs**: unless explicitly marked otherwise, `3` means **3%**, not `0.03`.
- **What volatility means here (`vol24hRangePct`)**: `((high24h - low24h) / low24h) * 100` from **24h ticker** data. It is not 1m candle volatility.
- **ROI% to price move**: `roiPct / leverage / 100`.
  - Example: `tpRoiPct=3`, `leverage=10` → price move target is `0.3%`.
- **Net PnL**: `grossPnl - fees` (entry fee + exit fee).
  - Example: 3 wins `+2,+2,+2` and 2 losses `-4,-4` gives gross `-2`. Even with 60% winrate, fees can push net further negative.
- **Today PnL** uses the **UTC** day boundary (00:00 UTC reset), not local timezone midnight.

## Universe filters (24h metrics, v1)

Universe uses only **24h ticker metrics**:
- `minTurnover` compares against `turnover24hUSDT` (Bybit ticker `turnover24h` / `turnover24hValue`).
- `minVolPct` compares against `vol24hRangePct` where:
  - `vol24hRangePct = (highPrice24h - lowPrice24h) / lowPrice24h * 100`

Important: top-bar last price change (for example CoinGlass `+0.31%`) is candle/change momentum, **not** this 24h range metric.

Universe definitions and units:
- `minTurnover` unit: **USDT over last 24h** (`turnover24hUSDT`).
  - Example: if `turnover24hUSDT = 8,500,000` and `minTurnover = 10,000,000`, symbol is filtered out.
- `minVolPct` unit: **percent** of 24h range (not decimal).
  - Formula: `vol24hRangePct = (highPrice24h - lowPrice24h) / lowPrice24h * 100`.
  - Example: `high=110`, `low=100` => `vol24hRangePct = 10`; `minVolPct=3` passes, `minVolPct=12` fails.

When 0 symbols pass filters:
- Universe build is still successful (`ready=true`) and is persisted.
- UI shows **"Universe built but empty (0 symbols)"** and reason counters (`byMetricThreshold`, `dataUnavailable`).
- `Download universe.json` continues to work.

When Bybit is unreachable / upstream fails:
- Create/refresh returns upstream error details (`code`, `hint`, `retryable`) and UI shows **"Upstream error (last build failed)"**.
- Last good persisted universe is preserved and still downloadable.
- Operator steps:
  1. Verify network/DNS/firewall/proxy to Bybit endpoint.
  2. Verify `BYBIT_REST` target and environment routing.
  3. Retry after short backoff (especially for `UPSTREAM_RATE_LIMIT`).
  4. For local QA, set `UNIVERSE_FORCE_UPSTREAM_ERROR=1` to simulate failure; unset to resume normal behavior.

Example:
- `highPrice24h=0.21324`, `lowPrice24h=0.19316`
- `vol24hRangePct = (0.21324-0.19316)/0.19316*100 ≈ 10.39%`
- so `minVolPct=10` passes, `minVolPct=12` fails.


## v1 execution math (paper)

- `notional = marginUSDT * leverage`
- Entry qty: `qty = notional / entryPrice` (then lot-size normalization)
- `entryOffsetPct` is applied first (entry limit), then TP/SL are derived from that entry price.
- Paper micro-fill knobs (optional, default keeps current behavior):
  - `paperEntrySlippageBps` (default `0`): adverse fill slippage on entry limit fills.
  - `paperExitSlippageBps` (default `0`): adverse slippage on TP/SL exits.
  - `paperPartialFillPct` (default `100`): filled size percent of normalized qty.
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
- `maxSpreadBps`: max allowed spread in **bps** for new entries. Example: `35` means `0.35%` max spread.
- `maxTickStalenessMs`: max age (ms) of latest ticker update before blocking new entries (`TICK_STALE`).
- `minSpreadBps`: legacy field retained for backward compatibility (not used by v1 gating).

### Example presets

- **fast_test_1m**
  - `trendTfMinutes=5`, `trendMinMovePct=0.1`, `confirmWindowBars=1`, `confirmMinContinuationPct=0.05`, `impulseMaxAgeBars=2`, `requireOiTwoCandles=false`
- **overnight_1m_safe**
  - `trendTfMinutes=15`, `trendMinMovePct=0.3`, `confirmWindowBars=2`, `confirmMinContinuationPct=0.1`, `impulseMaxAgeBars=2`, `requireOiTwoCandles=true`

## Guardrails defaults (default profile)

- `maxActiveSymbols = 3`
- `maxConsecutiveLosses = 3`
- `dailyLossLimitUSDT = 10`

Starter profiles are auto-seeded when missing (without overwriting existing profile names):
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
5. Slippage/partial fills: even with >55% winrate, net can stay negative if realized R:R after fees/slippage is poor

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

### “Universe built but 0 symbols passed filters”

Troubleshoot in this order:
1. Lower `minTurnover` first (most restrictive in quiet sessions).
2. Lower `minVolPct` (remember: `3` means 3%, not 0.03).
3. Check contract filter impact (`expiringOrNonPerp`): v1 allows only USDT linear perpetual symbols.
4. Check `dataUnavailable` count: missing/invalid ticker fields can exclude symbols.
5. Download `universe.json` and inspect `filteredOut` counters before widening bot-risk settings.

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

## Phases (operator semantics)

- **Signal phase** (`HOLDING_LONG`, `HOLDING_SHORT`, `ARMED_LONG`, `ARMED_SHORT`):
  signal confirmation is accumulating and/or waiting continuation; **no order exists** and **no position exists**.
- **Order phase** (`ENTRY_PENDING`):
  entry order exists (paper pending order or demo queued/sent order); position is still closed.
- **Position phase** (`POSITION_OPEN`):
  entry is filled and the position is live; TP/SL are active.

State invariants enforced by engine runtime checks:
- Signal phase => `pendingOrder == null` and `position == null`
- Order phase => `pendingOrder != null` and `position == null`
- Position phase => `position != null`

If an invariant is violated, v1 safe fallback is applied: symbol is logged and reset to `IDLE` (server keeps running).

## Operator QA checklist (Task 31)

1. **Universe**
   - Create with `minTurnover` and `minVolPct`.
   - Download `universe.json`.
   - Open **Universe Symbols**: verify search/sort/pagination and copy symbols.
   - Verify contract-filter counts are consistent (`symbols` vs `filteredOut`).
2. **Bot lifecycle**
   - Start in paper mode and confirm state becomes running.
   - Pause and verify `paused=true` plus snapshot availability.
   - Resume and verify state restoration (including universe/runtime context).
   - Kill and verify pending orders are cancelled, `BOT_KILL` is journaled, and demo open-position monitoring remains active.
   - Stop and verify `running=false`.
3. **Orders / Positions / Phase table**
   - Trigger a confirmed signal and verify `ENTRY_PENDING` appears with entry reason label.
   - Verify signal-phase rows show baseline/current mark+OI and deltas.
   - Verify order-phase rows show side/limit/qty/expires/status (queued/sent).
   - Verify fill transitions to `POSITION_OPEN` with entry/tp/sl/qty.
   - Verify close returns symbol to `IDLE` and `lastClosed` includes net + fees fields.
4. **Replay**
   - Start/stop recording and verify NDJSON file creation.
   - Start/stop replay and verify live feed is disabled then restored while state updates continue.
5. **Export pack**
   - Call `GET /api/export/pack` and verify zip contains:
     `universe.json`, `profiles.json`, `runtime.json`, `journal.ndjson`, `meta.json`.
   - Verify `meta.json` includes version + timestamp + notes placeholder.
6. **Reset all tables**
   - Run only while bot is stopped.
   - Verify runtime/stats/universe/journal/exclusions are reset while profiles are preserved.


## Operational presets

- `fast_test_1m`: 1–2 hour smoke preset with faster signal cadence and conservative guardrails. Use for short operator validation only (not unattended long sessions).
- `overnight_1m_safe`: slower higher-quality preset for unattended overnight monitoring with tighter spread/staleness controls and stricter confirmation.

These presets are seeded by backend startup only if missing, so user edits are preserved across upgrades.

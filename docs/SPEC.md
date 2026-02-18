# SPEC — Bybit OI/Price Bot (USDT Linear Perpetual)

## Goal
Local web app:
- Backend: Node.js **TypeScript**, Fastify, REST `/api/*`, WS `/ws` on `http://localhost:8080`
- Frontend: React (Vite), react-bootstrap, react-router-dom
- Exchange: Bybit **USDT‑margined Linear Perpetual**
- Modes: **paper** and **demo (REST trading)**. **Real trading: NOT implemented** (stub).

## Universe (manual)
- Create Universe button: fetch all linear perpetual symbols, apply filters, store as current Universe.
- Refresh Universe button: recompute filters; **keep active symbols** even if they fail filters.

### Filters
- `turnover24hUSDT >= 10_000_000`
- `vol24hRangePct >= minVolPct`
  - `vol24hRangePct = (highPrice24h - lowPrice24h) / lowPrice24h * 100`
- turnover/high/low source: Bybit v5 Market Tickers (last-price based).

### Active symbol preservation on refresh
Active symbols: `ENTRY_PENDING` or `POSITION_OPEN`.
On refresh: `universe = filteredNew ∪ activeSymbols`.

## Market data
- Use **mark price everywhere** for calculations, paper fill, TP/SL.
- OI metric is **openInterestValue** (USDT).

## Direction modes
`long | short | both`. In `both`: **SHORT priority** on conflict.

## Triggers (previous TF candle based)
Per-symbol trigger deltas compare current values to the previous TF candle (UTC bucket) for the configured `tf` (`1|3|5`).
- `priceDeltaPct = (markNow - prevCandleMark)/prevCandleMark*100`
- `oiDeltaPct = (oiNow - prevCandleOi)/prevCandleOi*100`
- First-candle fallback: when previous TF candle is unavailable/invalid (`null`/`0`), both deltas are treated as `0` and no signal is eligible.

Long:
- `priceDeltaPct >= priceUpThrPct`
- `oiDeltaPct >= oiUpThrPct` (default 50%)

Short:
- `priceDeltaPct < 0`
- `oiDeltaPct < 0` (no magnitude threshold)

Signal confirmation is counter-based: `signalCounterThreshold` (default 2) qualifying signals in a rolling 24h per symbol window.
- Counter increments only on qualifying SIGNAL events.
- Dedupe: max one increment per symbol per TF candle bucket (UTC).

## Timeframe gate (UTC)
User chooses `tf` ∈ {1,3,5}.
- In `IDLE`, engine may start HOLD only on UTC boundaries matching tf.
- Override: after cancel/close reset, evaluation may start immediately (deltas still use previous TF candle semantics).

## Orders/positions
- One active order or position per symbol.
- Manual cancel in UI.
- Auto-cancel entry after 1 hour if not filled.
- After cancel/close: baseline state is reset to current mark & OI value for lifecycle compatibility (trigger calculations still use previous TF candle values).

## Execution
Paper:
- LIMIT @ mark at confirmation.
- Qty normalization uses Bybit lotSizeFilter (qtyStep/minOrderQty/maxOrderQty) when available.
- If maxOrderQty is exceeded, qty is clamped to max and then step-normalized downward.
- If normalized qty is below minOrderQty, order is skipped and symbol remains IDLE.
- Fill model: buy filled when mark<=limit; sell filled when mark>=limit.
- Attached TP/SL internally; full close only.
- Fees: Bybit non-VIP schedule (config constants).
- Slippage: none artificial; based on mark crossing.

Demo:
- Trade via REST on demo domain only.
- Place LIMIT + attached TP/SL in one request.
- FIFO placement queue (concurrency=1).
- Order status via polling; cancel per symbol.
- Hedge/one-way compatibility: demo order create and market close retry with `positionIdx` mapping on `retCode=10001`.
- Demo close accounting: use Bybit closed-pnl endpoint best-effort, fallback to mark-price math for gross/fees/net.
- KILL in demo: cancel + close + confirmation polling (best-effort).

Real:
- Not implemented (stub).

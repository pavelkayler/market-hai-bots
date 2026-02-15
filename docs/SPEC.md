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
- `vol24hPct >= minVolPct`
  - `vol24hPct = (highPrice24h - lowPrice24h) / lowPrice24h * 100`
- turnover/high/low source: Bybit v5 Market Tickers (last-price based).

### Active symbol preservation on refresh
Active symbols: `ENTRY_PENDING` or `POSITION_OPEN`.
On refresh: `universe = filteredNew ∪ activeSymbols`.

## Market data
- Use **mark price everywhere** for calculations, paper fill, TP/SL.
- OI metric is **openInterestValue** (USDT).

## Direction modes
`long | short | both`. In `both`: **SHORT priority** on conflict.

## Triggers (baseline-based)
Per-symbol baseline: `basePrice` (mark), `baseOiValue`, `baseTs`.
- `priceDeltaPct = (markNow - basePrice)/basePrice*100`
- `oiDeltaPct = (oiNow - baseOiValue)/baseOiValue*100`

Long:
- `priceDeltaPct >= priceUpThrPct`
- `oiDeltaPct >= oiUpThrPct` (default 50%)

Short:
- `priceDeltaPct < 0`
- `oiDeltaPct < 0` (no magnitude threshold)

Hold: condition must remain true for `holdSeconds` (default 3s), recomputed on market updates.

## Timeframe gate (UTC)
User chooses `tf` ∈ {1,3,5}.
- In `IDLE`, engine may start HOLD only on UTC boundaries matching tf.
- Override: after baseline reset (cancel/close), evaluation may start immediately.

## Orders/positions
- One active order or position per symbol.
- Manual cancel in UI.
- Auto-cancel entry after 1 hour if not filled.
- After cancel/close: baseline reset to current mark & OI value.

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

Real:
- Not implemented (stub).

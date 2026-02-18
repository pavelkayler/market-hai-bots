# BYBIT — v5 endpoints & fields used (minimal)

## REST Market (mainnet)
- Instruments: `GET /v5/market/instruments-info?category=linear&limit=...&cursor=...`
  - Use lotSizeFilter qtyStep/minOrderQty/(maxOrderQty)
- Tickers: `GET /v5/market/tickers?category=linear`
  - Use turnover24h, highPrice24h, lowPrice24h, markPrice, openInterestValue

## Public WS (mainnet)
- URL: `wss://stream.bybit.com/v5/public/linear`
- Topic: `tickers.{symbol}`
  - Use symbol, markPrice, openInterestValue, ts

## Demo trading (REST)
- Base: `https://api-demo.bybit.com`
- Place: `POST /v5/order/create` (LIMIT + attached TP/SL, demo defaults to hedge mode mapping first: `Buy->1`, `Sell->2`; falls back to `positionIdx=0` on `retCode=10001`)
- Cancel: `POST /v5/order/cancel`
- Open orders polling: `GET /v5/order/realtime?category=linear&symbol=...`
- Closed PnL lookup (best-effort accounting): `GET /v5/position/closed-pnl?category=linear&symbol=...&limit=3`
- Positions polling (demo close detection): `GET /v5/position/list?category=linear&symbol=...`
  - Selection rule in hedge mode: prefer non-zero leg for symbol; if multiple non-zero, pick largest abs(size).
  - Key fields used: `symbol`, `size`, `avgPrice`, `side`, `positionIdx`, `leverage` (optional), `unrealisedPnl` (optional)
- Auth: HMAC SHA256 signing per v5

### Demo create order implemented fields
The demo order-create request currently sends these attached TP/SL fields:
- `takeProfit`
- `stopLoss`
- `tpTriggerBy` = `MarkPrice`
- `slTriggerBy` = `MarkPrice`

Parsing is locked by fixtures in `backend/test/fixtures/bybit` to prevent regressions.


### Hedge mode compatibility
- DEMO accounts are treated as **hedge-mode by default** to avoid avoidable first-attempt mismatch errors.
- Create orders: first attempt uses hedge mapping (`Buy->1`, `Sell->2`); on `retCode=10001` fallback retries once with `positionIdx=0` and caches one-way hint.
- Close orders: first attempt uses reduce-only hedge mapping (`Sell->1` closes long, `Buy->2` closes short); same safe one-way fallback is applied.
- Close accounting is best-effort: closed-pnl endpoint is used when available; fallback is mark-price math when unavailable.

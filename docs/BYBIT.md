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
- Place: `POST /v5/order/create` (LIMIT + attached TP/SL, tries `positionIdx=0` first; retries on `retCode=10001` with hedge index)
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
- Demo create and demo market-close submit `positionIdx=0` first (one-way safe).
- On `retCode=10001` (position mode mismatch), requests retry once with hedge index: create uses side mapping (`Buy->1`, `Sell->2`); close uses reduce-only mapping (`Sell->1` to close long, `Buy->2` to close short).
- Close accounting is best-effort: closed-pnl endpoint is used when available; fallback is mark-price math when unavailable.

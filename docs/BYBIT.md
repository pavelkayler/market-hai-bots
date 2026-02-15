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
- Place: `POST /v5/order/create` (LIMIT + attached TP/SL)
- Cancel: `POST /v5/order/cancel`
- Open orders polling: `GET /v5/order/realtime?category=linear&symbol=...`
- Positions polling (demo close detection): `GET /v5/position/list?category=linear&symbol=...`
  - Key fields used: `symbol`, `size`, `avgPrice`, `side`, `positionIdx`, `leverage` (optional), `unrealisedPnl` (optional)
- Auth: HMAC SHA256 signing per v5

### Demo create order implemented fields
The demo order-create request currently sends these attached TP/SL fields:
- `takeProfit`
- `stopLoss`
- `tpTriggerBy` = `MarkPrice`
- `slTriggerBy` = `MarkPrice`

# Bybit Paper Bot (Base Scaffold) — Step 1

This archive is **Step 4: Live market pipeline (Bybit WS tickers) + 1s backend updates + 5s UI updates** for the "Разработка" project.

## Structure
- `backend/` — Node.js (TypeScript) Fastify server with WebSocket `/ws`
- `frontend/` — React + TypeScript + Vite UI (2 pages, Universe tab placeholders)
- `shared/` — shared TypeScript types/contracts (imported by backend; frontend copies types for now)

## Requirements
- Node.js 20+ (recommended)

## Run (dev)
### Backend
```bash
cd backend
npm install
npm run dev
```

Backend starts on: `http://localhost:8080`  
WebSocket: `ws://localhost:8080/ws`

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Frontend starts on: `http://localhost:5173`

> In Step 1, backend generates **mock market data** once per second and broadcasts a snapshot.
> In later steps we will replace mock feed with Bybit WS and implement full Universe/strategy.

## Notes
- Frontend updates its displayed snapshot every **5 seconds** (as required).
- A manual **Refresh** button requests an immediate snapshot pull via WS message.

## Step 2 environment variables (optional)
Backend defaults to Bybit public linear WS:
- `BYBIT_PUBLIC_WS` (default: `wss://stream.bybit.com/v5/public/linear`)
- `BYBIT_PING_INTERVAL_MS` (default: `20000`)
- `BYBIT_RECONNECT_BASE_DELAY_MS` (default: `500`)
- `BYBIT_RECONNECT_MAX_DELAY_MS` (default: `30000`)

If your environment blocks outbound WS, backend will keep status `DISCONNECTED` and auto-retry.

## Step 3 Bybit REST
Universe build uses public REST:
- GET `/v5/market/instruments-info?category=linear` (pagination via cursor)
- GET `/v5/market/tickers?category=linear`

Env:
- `BYBIT_REST_BASE_URL` (default `https://api.bybit.com`)
- `BYBIT_REST_TIMEOUT_MS` (default `8000`)

## Step 4 WebSocket market pipeline
Backend subscribes to ticker stream per symbol via WS:
- Topic `tickers.{symbol}` includes `markPrice`, `openInterestValue`, `fundingRate`, `nextFundingTime`. citeturn1view0

Heartbeat:
- Send `{"op":"ping"}` every ~20s. citeturn2view0

Cadence:
- Backend applies latest tickers into `store.symbols` every **1s**
- Frontend renders snapshot every **5s** + manual Refresh

## Step 5 behavior
- Backend aggregates 1s ticker samples into candles for selected timeframe (1m/3m/5m/10m/15m).
- `priceDeltaPct` and `oiDeltaPct` are computed vs **previous candle close** values.
- Until the first candle is rolled, symbols stay in `WAITING_CANDLE`. After that -> `WAITING_TRIGGER`.

## Step 6 behavior
- Per-symbol statuses now advance beyond `WAITING_TRIGGER`:
  - `AWAITING_CONFIRMATION` when triggers counted < `minTriggersPerDay`
  - `ORDER_PLACED` when triggers counted >= min and <= max
- Daily counter resets by **MSK day**.
- Funding cooldown window enforced:
  - 30 minutes before next funding time
  - 10 minutes after next funding time
- Orders are paper objects appended to `openOrders`.

## Step 7 behavior
- When `ORDER_PLACED` order exists:
  - Buy fills when `markPrice <= entryPrice`
  - Sell fills when `markPrice >= entryPrice`
- On fill: creates `PaperPosition` with:
  - `qty = (marginUSDT * leverage) / entryPrice`
- Exit rules (evaluated each 1s):
  - TP when `ROI% >= tpRoiPct`
  - SL when `ROI% <= -abs(slRoiPct)`
- Home page now shows open orders and open positions (OPEN only).

## Step 8 behavior
- `SET_BOT_RUN_STATE: STOPPED` cancels all OPEN paper orders.
- Positions remain (paper positions are not force-closed).
- After a position closes -> symbol enters 1s cooldown then returns to `WAITING_TRIGGER`.

## Step 9 UI
- Home:
  - Connections (Frontend↔Backend WS, Backend↔Bybit WS) + bot state
  - Bot summary
  - Open positions
  - Open orders
- Dashboard:
  - Bot controls (Start/Stop) + Universe config Save
  - Universe Symbols tab with totals (total eligible / selected) and sortable columns

## Step 10 tests
Backend Vitest includes deterministic full-cycle test covering:
- candle roll -> deltas
- trigger counting (min/max + bucket gate)
- order placement with entryOffset
- order fill -> position open
- TP/SL exits by ROI%
- post-close cooldown (1s) returning to WAITING_TRIGGER
Also includes STOP-cancel helper test.

## Step 11 UI (3rd tab)
- Dashboard tab **Trade Results** shows aggregated outcomes across all symbols:
  - Trades, Wins/Losses, WinRate%, Net PnL (USDT), Net ROI%, Avg ROI%
- Table is sortable by any column.

## Step 12 Reset
- Added Reset button to bot controls.
- RESET resets:
  - all configs to defaults
  - all symbols/universe
  - all open orders/positions
  - trade history + aggregated results
  - bot state => STOPPED

## Step 13 Universe save
- Added `SAVE_UNIVERSE_PRESET` WS command.
- Universe save requires a name:
  - if user input is empty -> auto name `(vol%/turnover)` e.g. `(1%/10M)`
- Backend stores presets in `savedUniverses` and exposes in snapshot.
- UI shows saved universes list in Universe tab.

## Step 14 Remove symbol
- Added action `Remove` in Dashboard → Trade Results (3rd tab).
- Only there you can remove a symbol from the active universe.
- Backend behavior on remove:
  - cancels OPEN orders for the symbol
  - closes OPEN positions at current markPrice and records to tradeHistory
  - removes the symbol from current universe list
  - if currentUniverseName is set, also removes it from that saved universe preset

## Step 15 Kill
- Added Kill button in controls.
- Kill does:
  - cancels all OPEN orders
  - closes all OPEN positions at current markPrice and records to tradeHistory
  - botRunState => KILLED
  - backend loop stops candle/trigger/matching processing
  - ticker stream ignores updates while KILLED (metrics freeze)
- Start switches to RUNNING and resumes updates/processing.

## Step 16 tests
Added broader Vitest coverage:
- resetStore hard reset behavior
- universeName default formatting
- tradeResults aggregation via snapshot
- TriggerEngine scenarios (stopped, bucket gate, order placement)
- PaperMatcher short + SL path
- tickerStream applyToSymbols behavior

## Step 17 UI tech
Frontend now uses:
- react-router-dom (routes: / and /dashboard)
- react-bootstrap + bootstrap CSS
Navigation via Navbar.
Tables/Cards/Buttons migrated to react-bootstrap components.

## Step 18 Fees
Paper trading now accounts for Bybit VIP0 maker/taker fees for Perpetual & Futures (no VIP).
Assumption (per strategy spec):
- Entry: "market limit" -> treated as TAKER
- Exit: TP/SL -> treated as MAKER (limit)
Fees are charged on notional (price * qty) and deducted from realized PnL and ROI.

## Step 20 Trade History + Funding Analysis
- Snapshot now includes `tradeHistory` and `fundingStats.buckets`.
- Trade History tab shows each closed trade with direction (side), funding at entry, fees and WIN/LOSS.
- Funding Analysis tab aggregates by |funding| buckets with sign splits (ALL/POS/NEG).
- All tables remain sortable by any column.

## Step 21 Signals table
Added Dashboard tab **Signals** (Universe-only):
- symbol, current price
- last signal time (MSK)
- signal counter today (triggerCountToday)
- opened trades today, wins today
- price change today %, OI value change today %
- last update (seconds ago)
- Manual Refresh button (WS message `REFRESH_SIGNALS`)
Backend:
- `signalRows` are recomputed at most every 10 seconds (cached in Store), `signalsUpdatedAtMs` exposed in snapshot.

## Step 24 Fixes
- Fixed backend crash: `bybitRest.ts` was malformed (methods accidentally injected into interface).
- Added `overrides` in backend/frontend `package.json` to force patched transitive deps (esbuild/rollup) to reduce `npm audit` findings.

## Step 27 Vite proxy for WS/API
Fixes dev-mode connectivity:
- Vite dev server now proxies `/api` HTTP requests to backend `http://localhost:8080`
- Vite dev server now proxies WebSocket `/ws` to backend `ws://localhost:8080` (`ws: true`)
So frontend can keep using same-origin `/ws` and `/api` while running on `localhost:5173`.

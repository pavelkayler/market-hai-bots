# Release Candidate (RC) workflow — v2 refactor complete

This project is now **v2 refactor complete** for the operator contract in this document.

## Prerequisites

- Node.js 20+
- npm install at repo root (which installs backend/frontend deps via workspaces layout in this repo)
- Bybit USDT Linear Perpetual symbols only in universe
- For demo checks: valid `DEMO_API_KEY` and `DEMO_API_SECRET`

## Start services

1. Start backend:
   - `npm run dev:backend`
2. Start frontend:
   - `npm run dev:frontend`

## Create universe

1. Open Bot page.
2. Set `Min Vol %` and `Min Turnover`.
3. Click **Create**.
4. Confirm Universe `Ready: true` and non-zero symbols count.

## Verify Doctor

1. Open Doctor page.
2. Confirm `/api/doctor` reports `ok: true` and no FAIL checks.
3. CLI alternative:
   - `npm run rc:smoke`

## Verify Bot state contract and funding columns

1. Open Bot page Active symbols table.
2. Confirm columns appear in this order:
   - Symbol | Mark | OIV | ΔPrice% | ΔOIV% | Funding | Next funding (ETA) | Tradability | SignalCount | LastSignal
3. Confirm symbols with missing funding render `MISSING` badge and do not crash UI.

## Paper test (signal counter and MSK day behavior)

1. Start bot in `paper` mode with low thresholds (`priceUpThrPct`, `oiUpThrPct`) and small TF.
2. Observe signal count increments at most once per TF bucket per symbol.
3. Around MSK day boundary (00:00 MSK), confirm signal counter fields reset for each symbol while runtime keeps operating.

## Demo test (hedge mode and funding blackout close path)

1. Start bot in `demo` mode with hedge-mode account.
2. Confirm opening side uses deterministic `positionIdx` mapping.
3. During funding blackout window, confirm behavior per symbol:
   - cancel active orders first
   - then reduce-only market close with deterministic `positionIdx`
   - repeated ticks do not spam close/cancel beyond throttle window
   - after funding pass, symbol remains in `COOLDOWN` for 10 minutes

## RC smoke (single command)

- Run:
  - `npm run rc:smoke`
- Expected:
  - exits 0
  - prints doctor summary
  - validates `/api/bot/state` required keys and numeric activity values

## UI layout checks (current v2)

- Home page is minimal status-only: REST badge, WS badge, and a single WS status message banner.
- Bot page has exactly four operator tabs:
  - Dashboard (status summary + Lifecycle controls Start/Stop/Kill/Reset, with Reset STOP-only)
  - Settings (Universe panel first, Settings panel below)
  - Active symbols (existing funding-safe table)
  - Per-symbol results (sortable table with Symbol/Trades/Wins/Losses/Winrate/Longs/Shorts minimum columns)

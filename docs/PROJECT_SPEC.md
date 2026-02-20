# Project spec (paper-only) — Bybit USDT Perpetual momentum/funding bot

## Stack
- Frontend: Vite + React + React-Bootstrap + react-router-dom + TypeScript
- Backend: Node.js (ESM) + Fastify + @fastify/websocket + WebSocket to Bybit + REST to Bybit
- Mode: Paper trading only

## Pages
1) Home
- Connection status: Frontend↔Backend WS, Backend↔Bybit WS
- Bot global state: RUNNING/STOPPED/KILLED
- Open positions table
- Open orders table
- Manual UI Refresh (top)

2) Dashboard (2nd page, tabbed)
Tabs:
- Dashboard: controls + configs + universe builder + summary
- Universe Symbols: table of universe metrics and per-symbol statuses
- Trade Results: per-symbol aggregated stats
- Trade History: all trades
- Signals: per-symbol signals table (special cadence)
- Requests: separate page (not a tab), see Requests section

3) Requests (separate route)
- Symbol selector (ALL USDT linear perps, not only Universe)
- Button "Обновить"
- Table: Request Name / Response
- Two blocks: WebSocket requests (virtual) and REST API responses (real)

## Universe
Universe is the active set of USDT linear perpetual symbols.
Filters:
- min daily volatility %: (high-low)/low*100 over current day
- min daily turnover USD (default 10,000,000; testing may use 1,000,000)
Universe can be saved with a name (default name derived from filters).
Symbols can be removed ONLY from Trade Results tab.

## Strategy core (per symbol)
Timeframes: 1m, 3m, 5m, 10m, 15m (selectable).
Triggers (per timeframe candle-to-candle delta):
- Price delta % vs previous candle close >= threshold
- Open Interest Value delta % vs previous candle >= threshold
- Funding rate abs >= threshold

Direction:
- funding < 0 -> SHORT
- funding > 0 -> LONG

Confirmation counts:
- require N signals per day before entering (min/max counters)

Entry:
- marketable limit at price +/- entryOffset (long below, short above)

Exit:
- limit TP/SL based on ROI% (from margin & leverage)
Fees:
- include Bybit VIP0 maker/taker fees; track per trade and totals in summary.

Cooldown:
- Funding cooldown: -30m before funding timestamp, +10m after

Global bot state:
- RUNNING: all calculations active
- STOPPED: timers stopped, cancel open orders, keep positions
- KILLED: cancel orders, close positions, stop everything; restart resumes

Reset:
- resets all tables/stats/settings to defaults.

## Cadence
Backend updates: typically 1s (market pipeline).
Frontend UI refresh: 5s (from snapshots), sorting supported on all tables.
Signals table: 10s cadence (both backend and frontend), but price may still update at 5s.

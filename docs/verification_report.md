# Release Verification Report

- Date/time: 2026-02-15 09:37:44 UTC
- Environment: local container
- Node.js: v22.21.1
- npm: 11.4.2

## Scope
Momentum bot + Manual DEMO + Universe Search + Status (Bybit only), futures-only/USDT linear.

## Verification summary by section

1. **Status (Bybit only)** — **PASS (code/API shape)**
   - Confirmed status page contains only Bybit section (no CMC UI block).
   - Confirmed `/api/status/watch` computes `lastTickAgeSec` as `Date.now() - lastTickTs` in seconds (not raw timestamp).

2. **Universe Search tiers refresh** — **PASS (code-path review), runtime limited**
   - Reviewed server routes/services and frontend bindings; result endpoint and tier rendering wired to latest search result.
   - Could not fully execute end-to-end with live Bybit in this environment due outbound network `ENETUNREACH`.

3. **Momentum settings UX/validation/persistence** — **PASS (tests + code review)**
   - `windowMinutes` restricted to 1/3/5 in backend validation and dropdown in UI.
   - Tier selection is checkbox-based for 1..6 with select/clear all controls.
   - Persist-on-change logic present via immediate patch requests.

4. **Momentum create/start error visibility** — **PASS (code review)**
   - Create errors are surfaced via `alert(...)`; empty tier selection explicitly rejected.

5. **Momentum inspector previous-candle logic** — **PASS (unit tests + code review)**
   - Existing momentum tests validate stale OI/threshold behavior and window validations.

6. **Momentum signals limits** — **PASS (code review)**
   - Latest signals requested with hard limit 3.
   - Fixed signals requested with limit 10 and displayed in scrollable container.

7. **Bots list summary/continue/stats/delete** — **PASS (code review), runtime limited**
   - Continue available only for STOPPED bots.
   - View stats requests runs + trades.

8. **Manual DEMO positions/orders/TP display** — **BUG FOUND & FIXED**
   - See fixed bugs section below.

9. **Market data snapshot non-zero + pinned symbols** — **runtime limited**
   - Could not verify live snapshot values due Bybit network unreachability in this environment.

## Fixed bugs (minimal patches)

### BUG-1: Backend crashed on startup when Bybit WS/REST was unreachable
- Repro:
  1. Run backend with no outbound route to Bybit.
  2. Observe process crash (`TypeError: fetch failed` / unhandled WS error).
- Expected: server should start, log warnings, and keep running (degraded mode).
- Actual: process exited.
- Code location: `backend/src/services/momentum/momentumMarketData.js`
- Fix:
  - Wrapped initial `fetchUniverse()` bootstrap in `try/catch` with warning log.
  - Added `ws.on('error', ...)` handler to avoid unhandled emitter crash.

### BUG-2: Manual DEMO Open Orders table missed required `type` column and TP fallback reason
- Repro:
  1. Open Manual DEMO page.
  2. Check Open Orders columns; `type` missing.
  3. For position without `position.takeProfit` and without TP reduce-only order, TP cell showed plain `-` without reason.
- Expected:
  - Open Orders includes `type` column.
  - TP fallback shows reason when TP order absent.
- Actual:
  - `type` absent.
  - TP displayed as `-` only.
- Code location: `frontend/src/pages/manual/ManualDemoTradePage.jsx`
- Fix:
  - Added `type` column (`orderType || type`).
  - TP cell now shows `TP(order): <price>` when derived from reduce-only order; otherwise `— (NO_TP_ORDER)`.

## Notes
- `rg -n "leadLag|leadlag|paperTest|leader|follower"` returned no matches.
- Bybit connectivity from this container intermittently/universally fails with `ENETUNREACH`, so live market assertions were partially constrained.

# QA Checklist (Release Readiness, v1)

Use this as an operator runbook. Each step includes expected outcome.

## A) Universe lifecycle
1. Click **Create Universe** with `minTurnover` and `minVolPct`.
   - Expect success toast and `ready=true` in Universe state.
2. Click **Refresh Universe**.
   - Expect filters preserved/canonicalized and counters (`passed`, `excludedCount`, `contract filter`) updated.
3. Click **Get Universe**.
   - Expect symbols table loaded with `symbol`, turnover, vol24h range, 24h high/low.
4. Use **search**, click column headers to **sort**, and move between pages.
   - Expect stable sort and pagination; search narrows results immediately.
5. Click **Download universe.json**.
   - Expect JSON file download with canonical fields (`ready`, `filters`, `contractFilter`, `symbols`).
6. Create an intentionally strict universe (high `minTurnover` and/or high `minVolPct`) so 0 symbols pass.
   - Expect `createdAt` present, empty-state message (`Universe built but 0 symbols passed filters.`), and reason counts shown.
   - Expect **Download universe.json** to still work for this empty persisted state.
7. Layout smoke:
   - Universe card fits without large blank vertical gaps.
   - Universe/table rows appear dense and aligned; no overlap/clipping.
8. Click **Clear Universe**.
   - Expect `ready=false` and symbols table cleared.


## A2) Universe network troubleshooting (new)
1. Create a valid universe once (confirm `Download universe.json` works).
2. Simulate upstream failure (`UNIVERSE_FORCE_UPSTREAM_ERROR=1`) and click **Refresh Universe**.
   - Expect UI status: **"Upstream error (last build failed)"** with error code/hint.
   - Expect UI to show `Last known universe: available`.
3. Click **Download universe.json** after failed refresh.
   - Expect download still succeeds with the previous persisted universe.
4. Remove simulation flag and refresh again.
   - Expect UI status returns to **Universe ready (N symbols)** or **Universe built but empty (0 symbols)**.
5. Distinguish states in UI:
   - **No universe yet**: no `createdAt`, never built.
   - **Universe built but empty**: `ready=true` and `symbols=0`.
   - **Upstream error**: `upstreamStatus=error` with code/hint; does not imply universe file loss.

## B) Bot lifecycle / snapshot behavior
1. With universe ready, click **Start**.
   - Expect bot state `running=true`; settings become locked.
2. Click **Pause**.
   - Expect `paused=true`, `hasSnapshot=true`, journal includes `BOT_PAUSE`.
3. Click **Resume**.
   - Expect `running=true`, `paused=false`, snapshot-based state restored (including last config).
4. Click **Stop**.
   - Expect `running=false` and no new orders.
5. After a reset/clear of runtime, click **Resume**.
   - Expect error `NO_SNAPSHOT`.

## C) Paper trade lifecycle
1. Start in **paper** mode with `signalCounterThreshold >= 2`, `entryOffsetPct > 0`.
2. Feed/observe qualifying signal ticks across UTC candle boundaries.
   - Expect counter increments once per UTC candle (dedupe within same candle).
3. After threshold is met:
   - Expect `ENTRY_PENDING` limit order at mark ± `entryOffsetPct`.
4. Move mark through limit.
   - Expect fill and phase `POSITION_OPEN`.
5. Move mark to TP or SL.
   - Expect close event, `POSITION_CLOSED`, journal records, and stats update using **net PnL (fees included)**.

## D) Demo lifecycle
1. Start in **demo** mode with credentials configured.
2. Trigger an entry.
   - Expect queued order -> sent order transition.
3. Cancel a queued order.
   - Expect local queue cancellation, no remote cancel required.
4. Cancel a sent order.
   - Expect remote cancel request and state cleared after polling.
5. Keep polling enabled.
   - Expect open orders synced and position-list polling used for close detection.

## E) Replay lifecycle
1. Start recording (`record/start`), then stop.
   - Expect file appears in replay files list.
2. Start replay with a selected speed (1x/2x/5x/fast).
   - Expect replaying state + progress counters increase.
3. Stop replay.
   - Expect live feed restored and replay flags reset.
4. Try enabling record while replaying (and vice versa).
   - Expect mutual-exclusion rejection.
5. If trading during replay is disabled by config/design:
   - Expect no new live trades while replay is active.

## F) Reset all
1. With bot running, call **Reset all**.
   - Expect reject with `BOT_RUNNING`.
2. Stop bot, then call **Reset all**.
   - Expect success with cleared: stats/journal/runtime/exclusions/universe/replay.
3. Validate after reset:
   - Runtime state cleared, exclusions empty, universe not ready, replay stopped.
   - Profiles remain intact (default + saved profiles still present).

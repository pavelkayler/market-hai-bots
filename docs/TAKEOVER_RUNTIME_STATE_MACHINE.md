# TAKEOVER_RUNTIME_STATE_MACHINE

## Runtime lifecycle model (operator-level)

### Top-level bot lifecycle
- `STOPPED`: `running=false`, `paused=false`.
- `RUNNING`: `running=true`, `paused=false`.
- `PAUSED`: `running` может быть false/true на уровне engine restore/guardrail, но operator flow трактует как paused lifecycle (`paused=true` + snapshot-based resume path).
- `KILL_IN_PROGRESS`: transient UI/server marker (`killInProgress=true`).

### Symbol-level FSM states
- `IDLE`
- `HOLDING_LONG`
- `HOLDING_SHORT`
- `ARMED_LONG`
- `ARMED_SHORT`
- `ENTRY_PENDING`
- `POSITION_OPEN`

## Allowed transitions (API lifecycle)

### `start`
- Preconditions:
  - universe ready and non-empty
  - market hub running
  - valid config/profile
  - demo mode only when demo creds configured
- Transition: `STOPPED|PAUSED -> RUNNING`

### `pause`
- Transition: `RUNNING -> PAUSED`
- Side effects: uptime finalized, snapshot persisted, ops journal `BOT_PAUSE` best-effort.

### `resume`
- Preconditions:
  - snapshot exists (`hasSnapshot=true`)
  - effective universe not empty
  - market hub running
- Transition: `PAUSED -> RUNNING`
- On failure: HTTP 400 (`NO_SNAPSHOT` or `UNIVERSE_NOT_READY`).

### `stop`
- Transition: `RUNNING|PAUSED -> STOPPED`
- Side effects: run stats flushed, run event `BOT_STOP`, snapshot updated.

### `kill`
Deterministic intent path:
1) pause with guardrail reason `KILL_SWITCH`
2) cancel pending entry orders
3) close open positions (demo: exchange close attempt; paper: force close)
4) recompute counts, persist snapshot
5) set `killInProgress=false`, `killCompletedAt=now`, call `stop()`
6) report residual counts + warning if non-zero

### `reset-all`
- Hard guard: only when bot NOT running (`BOT_RUNNING` reject while running).
- Side effects: stop replay/record, stop bot, reset stats/runtime symbols, clear journal/exclusions/universe/snapshot, clear subscriptions.

### `export`
- Always succeeds as partial export (unless catastrophic zip failure):
  - `meta.json` always included
  - optional files added only if present
  - missing files logged in `meta.json.notes`

### `record (replay/record subsystem)`
- `record/start`: requires universe ready; forbidden when replaying/recording (`REPLAY_BUSY`).
- `record/stop`: idempotent safe stop.

### `replay (replay/record subsystem)`
- `replay/start`: forbidden when recording/replaying (`REPLAY_BUSY`), and when bot running in non-paper mode (`REPLAY_REQUIRES_PAPER_MODE`).
- `replay/stop`: idempotent safe stop with live market restore.

## Explicitly forbidden/impossible states

### Runtime forbidden states
- `reset-all` while bot is running.
- replay and record active simultaneously.

### Phase correctness (UI normalization)
- Position exists + state != `POSITION_OPEN` → normalized to `POSITION_OPEN` in UI.
- Pending order exists + state == `IDLE` → normalized to `ENTRY_PENDING` in UI.
- Tracked table hides `IDLE` rows without pending order/position.

### Strategy/FSM invariant guard
- Engine contains invariant checker that logs and resets state on invalid combinations (e.g., holding/pending/position mismatch).

## How to verify
1. API checks:
   - `POST /api/bot/start|pause|resume|stop|kill|reset/all`
   - verify expected 200/400 codes and payload guards.
2. Kill deterministic closure:
   - start bot, open paper positions/orders, call `POST /api/bot/kill`, then `GET /api/bot/state` and confirm `openPositions=0`, `activeOrders=0`, `running=false`.
3. Reset guard:
   - while running call `POST /api/reset/all`, expect `400 BOT_RUNNING`.
4. Replay/record exclusion:
   - `record/start` then `replay/start` => `REPLAY_BUSY`.
   - `replay/start` then `record/start` => `REPLAY_BUSY`.
5. UI phase correctness:
   - inspect BotPage “Tracked symbols” while receiving WS updates, verify no impossible rows appear.

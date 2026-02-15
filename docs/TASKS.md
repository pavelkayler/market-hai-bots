# TASKS — MVP checklist (update after each Codex patch)

## Milestone: Local MVP (paper + demo, no real trading)

### Backend
- [ ] Fastify server (TS), REST `/api/*`, WS `/ws` on `localhost:8080`.
- [ ] Universe endpoints: create/refresh/get + persist `data/universe.json`.
- [ ] Public WS market hub (tickers.{symbol}).
- [ ] FSM engine (baseline, hold, tf gate + override, short priority).
- [ ] Paper executor.
- [ ] Demo executor (signer + queue + polling + cancel).
- [ ] Real executor stub.

### Frontend
- [ ] Bot page: Universe create/refresh, settings, start/stop, orders/positions, cancel, 5-line log.

## Known limitations
- Demo position-close detection uses a polling heuristic: if no matching open order is seen for consecutive polls, the position is treated as closed at current mark for MVP state progression.
- Paper fee rates are currently default assumptions (`DEFAULT_BYBIT_LINEAR_MAKER_FEE_RATE`, `DEFAULT_BYBIT_LINEAR_TAKER_FEE_RATE`) pending explicit confirmation in project docs/source of truth.

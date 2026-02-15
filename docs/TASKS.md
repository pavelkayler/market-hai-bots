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

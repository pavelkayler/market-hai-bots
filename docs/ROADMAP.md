# Roadmap (stabilization-first, no feature expansion)

## Phase A — Build & connectivity stability
1. Ensure backend starts cleanly (no runtime exceptions on `/ws`).
2. Ensure Vite proxy for `/api` and `/ws` is correct.
3. Ensure snapshot is complete (no `undefined` fields) and sent on connect.

## Phase B — State consistency
4. Store invariants: all arrays exist, reset does not break UI.
5. Bot run state transitions: RUNNING/STOPPED/KILLED fully consistent with orders/positions.

## Phase C — Universe correctness
6. Rebuild universe updates:
   - `universe.total/selected`
   - `symbols[]`
   - subscriptions (ticker-stream desired/subscribed)
7. Save universe preset naming and persistence in snapshot.

## Phase D — Paper trading correctness
8. Matching engine: enter/exit + fees applied; trade history & aggregates consistent.
9. Remove symbol: removes everywhere; handles linked orders/positions safely.

## Phase E — UI bindings hardening
10. Every button produces an ACK/ERROR and a snapshot update.
11. Sorting: stable keys, no row jumping.
12. Requests page works independently of WS.

## Phase F — Regression tests
13. Add/expand tests for:
   - WS connect/snapshot
   - STOP/KILL/RESET
   - Universe rebuild/save
   - Signals cadence & refresh
   - fees summary correctness
14. CI-like local commands: `npm test` backend + frontend.

Definition of Done:
- No console errors on normal use.
- WS stays connected.
- Tables always render, data consistent, buttons work.

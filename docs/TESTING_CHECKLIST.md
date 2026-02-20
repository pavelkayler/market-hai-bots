# Testing checklist (must pass before shipping)

## Backend
- `npm test` passes
- `npm run dev` starts, logs:
  - bybit WS connected
  - server listening
- Connect WS client:
  - receive SNAPSHOT immediately
  - no exceptions in wsHub
- Actions:
  - REBUILD_UNIVERSE updates universe + symbols and broadcasts snapshot
  - START/STOP: cancels orders on STOP, keeps positions
  - KILL: cancels orders, closes positions, sets KILLED
  - RESET: clears tables, restores defaults, no undefined

## Frontend
- `npm run dev` starts, no red errors
- WS status becomes CONNECTED
- All tables render on empty state (fresh boot) and after RESET
- Sorting works on each table (click headers)

## Cross
- End-to-end: simulate triggers -> order -> position -> close
- Fees:
  - per trade fee recorded
  - total fees visible in summary

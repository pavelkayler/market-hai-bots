# STATE — per-symbol FSM + baseline rules

## Baseline
Resettable baseline per symbol:
- basePrice = mark
- baseOiValue = openInterestValue
- baseTs

Reset baseline:
- after entry cancel (manual or auto 1h)
- after position close (TP/SL)
After reset: evaluation may start immediately (tf override).

## States
IDLE, HOLDING_LONG, HOLDING_SHORT, ENTRY_PENDING, POSITION_OPEN

## Transitions
- IDLE -> HOLDING_* when eligible (tf boundary or override) and condition true
- HOLDING_* -> IDLE if condition breaks
- HOLDING_* -> ENTRY_PENDING when `signalCount24h >= signalCounterThreshold` (rolling 24h, deduped per TF UTC bucket).
- ENTRY_PENDING -> POSITION_OPEN when filled
- ENTRY_PENDING -> IDLE on cancel/expiry (reset baseline)
- POSITION_OPEN -> IDLE on TP/SL close (reset baseline)

Constraints:
- No signal evaluation in ENTRY_PENDING/POSITION_OPEN.
- Short priority in BOTH.
- Auto-cancel ENTRY_PENDING after 1 hour.

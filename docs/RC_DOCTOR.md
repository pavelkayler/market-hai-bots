# RC Checklist (v2 ready-to-trade)

Use this minimal checklist before live operation.

1. Start backend and frontend.
2. Create Universe (USDT linear perpetual only).
3. Open **Doctor** page and confirm checks are PASS/WARN only:
   - `ws_freshness`
   - `market_age_per_symbol`
   - `lifecycle_invariants`
   - `universe_contract_filter`
4. Open **Bot** page and verify symbols table shows:
   - `fundingRate` numeric or **MISSING** badge
   - `nextFundingTime`
   - `timeToFunding`
   - tradability badge: `OK | BLACKOUT | COOLDOWN | MISSING`
   - `signalCount24h` and `lastSignalAt`
5. Funding blackout validation:
   - Observe a symbol with `timeToFunding < 30m`.
   - Confirm status becomes `BLACKOUT` and bot cancels/closes symbol exposure.
   - Confirm no re-entry until cooldown (`COOLDOWN`) ends.
6. Kill switch validation:
   - Trigger KILL.
   - Confirm orders are canceled, open positions are closed (best effort), and lifecycle stabilizes in STOPPED.

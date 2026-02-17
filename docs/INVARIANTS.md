# INVARIANTS — must never be violated (Codex rules)

1. Mark price everywhere.
2. OI metric is openInterestValue.
3. Universe filters: turnover24h>=10,000,000 and vol24hRangePct=(high-low)/low*100 >= minVolPct.
4. Universe is manual (create/refresh).
5. Refresh preserves active symbols (pending/open position).
6. Triggers are baseline-based.
7. Direction modes long/short/both; in both SHORT priority.
8. Entry confirmation is counter-based (`signalCounterThreshold`) with continuation/guardrail gates (legacy `holdSeconds` may exist in old profiles but is not the primary v1 gate).
9. One active order/position per symbol.
10. Auto-cancel entry after 1 hour.
11. After cancel/close: baseline reset to current mark & OI.
12. TF override after baseline reset.
13. Paper LIMIT@mark, fill by mark crossing.
14. Demo REST only (api-demo.bybit.com) + FIFO queue concurrency=1.
15. Real trading NOT IMPLEMENTED.

Percent convention (all operator inputs): `3` means **3%**, not `0.03`.

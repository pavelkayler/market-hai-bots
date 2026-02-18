# FUNCTIONAL_COVERAGE_REPORT

## Section 1 — Spec Surface

Аудируемые поверхности:
1. Universe (build/refresh/filter/persist/exclusions)
2. Engine/FSM/Strategy
3. Execution: Paper + Demo
4. Guardrails
5. Kill / Reset / Export
6. Runs recorder
7. AutoTune persistence/API
8. Replay record/replay
9. Profiles
10. Journal
11. UI tabs + lifecycle workflow + phase correctness
12. REST/WS contracts
13. Snapshot/backward compatibility

## Section 2 — Coverage Matrix

| Requirement | Status | Evidence | How to verify | Notes / risks |
|---|---|---|---|---|
| Bybit USDT Linear Perpetual ONLY | PASS | `backend/src/services/universeContractFilter.ts`, `backend/src/services/universeService.ts` | `npm --prefix backend test -- universeContractFilter.test.ts universeService.test.ts` | Excludes nonLinear/nonUSDT/nonPerp/expiring/nonTrading. |
| Exclude dated/expiring futures | PASS | `classifyUsdtLinearPerpetualInstrument` checks `contractType`, `deliveryTime`, symbol suffix | Unit test `backend/test/universeContractFilter.test.ts` | Included in same filter invariant. |
| Percent convention: `3 == 3%` | PASS | `backend/test/percentConvention.test.ts`, `percentToFraction` usage in engine | `npm --prefix backend test -- percentConvention.test.ts` | Also reflected in settings docs. |
| ROI/leverage math (`roi/leverage/100`) | PASS | `backend/src/bot/botEngine.ts` TP/SL formula with `percentToFraction(tpRoiPct/leverage)` | grep formula + integration tests | No drift detected. |
| State payloads additive + snapshot-safe | PARTIAL | `restoreFromSnapshot` default injection, `normalizeBotConfig`, universe sanitize | restart with old-like snapshot/profile payload | Additive behavior present; no formal versioned schema tag. |
| Reset-all STOP-only | PASS | `/api/reset/all` guard `if (botState.running) BOT_RUNNING` | run bot then call endpoint | Explicit 400 rejection. |
| KILL deterministic flatten intent | PASS | `killSwitch` now confirms demo close via polling before local clear; warning + residuals surfaced deterministically | simulate demo close failure and assert residuals remain | No silent local force-close on unconfirmed demo close. |
| Execution accounting (paper PnL/fees/slippage/spread consistency) | PASS | `backend/src/utils/pnlMath.ts` reused by paper close + kill close; trade payloads include fee/slippage/spread fields | `backend/test/pnlMath.test.ts`, `backend/test/botEngine.test.ts` (hardening + payload validation) | Ensures entry/exit fees and net PnL are computed from one helper. |
| Signal counter threshold (rolling 24h + TF-bucket dedupe) | PASS | `backend/src/bot/botEngine.ts`, `backend/src/server.ts`, `backend/src/ws/symbolUpdateBroadcaster.ts`, `frontend/src/pages/BotPage.tsx` | `npm --prefix backend test -- botEngine.test.ts`; manual TF bucket checks | `holdSeconds` no longer gates confirmation; diagnostics expose count/threshold/confirmed/last signal. |
| Entry offset percent for entry LIMITs (paper+demo) | PASS | `backend/src/bot/botEngine.ts`, `frontend/src/pages/BotPage.tsx` | `npm --prefix backend test -- botEngine.test.ts` | Entry price uses mark*(1±entryOffsetPct/100) then tick rounding; TP/SL remain unchanged. |
| Demo outbound validation + state mapping | PASS | Demo entry payload validated before REST; `/api/bot/state` now includes `openOrders`, `positions`, `symbolUpdatesPerSec`, `journalAgeMs` | `backend/test/botEngine.test.ts` demo payload/close tests + manual `/api/bot/state` check | Prevents fake-success local state mutation on invalid payloads. |
| KILL final stable state `openPositions=0 activeOrders=0` | PARTIAL | returns `activeOrdersRemaining/openPositionsRemaining` + warning | assert post-kill `/api/bot/state` and response counters | Incomplete flatten can still happen on exchange-side failures, now explicitly surfaced. |
| Export pack robust/partial with mandatory meta.json | PASS | `/api/export/pack` always writes `meta.json`, optional files conditional | delete optional files then export and inspect zip | Journaling failures don’t abort export op. |
| Best-effort journaling should not fail operation | PASS | `appendOpsJournalEvent` catches journal errors, still appends run event | existing server tests mocking journal failure | Warn-only logging behavior. |
| UI phase correctness (no impossible lifecycle states) | PASS | `frontend/src/pages/BotPage.tsx` trackedSymbols normalization | run UI and inspect tracked symbols rendering | Client-side normalization masks upstream issues (P2). |
| Replay/Record mutual exclusion | PASS | `ReplayService.startRecording/startReplay` checks `recording||replay` | start one mode then second | returns `REPLAY_BUSY`. |
| Replay requires paper mode when bot running | PASS | `REPLAY_REQUIRES_PAPER_MODE` guard | run bot in demo and start replay | mapped to HTTP 400. |
| Universe create/refresh upstream error payload | PASS | `server.ts` returns structured 502 with diagnostics/upstreamError | mock upstream failure in tests | Last known universe preserved. |
| Universe exclusions persistence | PASS | `UniverseExclusionsService` + endpoints add/remove/clear | `npm --prefix backend test -- universeExclusionsService.test.ts` | Also writes timestamp snapshots. |
| Profiles additive/back-compat normalization | PASS | `ProfileService.load/import` with `normalizeBotConfig` | import old/incomplete profile JSON | default profile auto-restored. |
| Runtime snapshot persistence and restore | PASS | `snapshotStore.ts` + engine restore + server onReady loading | stop/start backend and inspect state | restore into paused snapshot flow. |
| Runs recorder present for every run session | PASS | `server.ts` start/resume/stop/kill writes run metadata/events/stats best-effort | start -> stop, pause -> resume, kill; inspect `data/runs/*` | `/api/runs/:id/download` now includes `stats.json` when present/valid. |
| Run history summary API (`/api/runs/summary`) | PASS | `RunHistoryService` + route in `server.ts` | create runs with/without stats and query summary | Best-effort parse with per-run warnings. |
| Operator run history surface (Runs tab + run detail tail + last auto-tune panel) | PASS | `backend/src/services/runEventsService.ts`, `backend/src/server.ts`, `frontend/src/pages/BotPage.tsx` | open Runs tab, expand Details, verify SYSTEM tail and dashboard last-auto-tune card | Evidence: `/api/runs/summary`, `/api/runs/:id/events`, `/api/autotune/history`, and UI controls wired without polling loops. |
| Bot UI tabs render isolated content | PASS | `frontend/src/pages/BotPage.tsx` tab-conditional blocks (journal/log/per-symbol/entry reasons) | click each tab, verify controls/table/cards render | No extra polling added for inactive tabs. |
| Dashboard metrics are unified (no duplicate Results card) | PASS | `frontend/src/pages/BotPage.tsx` dashboard card groups performance/costs/guardrails/runtime | open dashboard and verify single metrics panel | Last events limited to 3 rows. |
| AutoTune v1 planner (deterministic, bounded, single-change) | PASS | `autoTunePlanner.ts` + close-handler integration | synthetic planner tests + close-event integration test | GLOBAL and UNIVERSE_ONLY scope behavior enforced. |
| AutoTune persistence policy | PASS | runtime patch via `applyConfigPatch`; profile write only for active-profile start | start via active profile and verify profile update on apply | manual-start runs do not overwrite profiles. |
| REST/WS contract frontend-backend alignment | PASS | `server.ts`, `symbolUpdateBroadcaster.ts`, `frontend/src/types.ts`, `frontend/src/App.tsx` | run app and inspect WS messages | Additive optional fields used. |

## Section 3 — Contradictions & Drift

1. **`docs/TASKS.md` checklist stale vs implemented code**
   - Drift: many backend/frontend milestones unchecked though routes/features already exist.
   - More authoritative source: code (`backend/src/server.ts`, `frontend/src/pages/BotPage.tsx`) because executable and tested.
   - Follow-up: refresh checklist with actual completion status.

2. **`docs/QA_REPORT_LATEST.md` is template placeholders, not latest run evidence**
   - Drift: file name implies real report.
   - More authoritative source: CI/terminal command outputs and committed test results.
   - Follow-up: replace placeholders with actual timestamped execution logs.

3. **Release notes “No ML/autotune/optimizer in v1” vs existing autotune subsystem**
   - Drift: `AutoTuneService` and `/api/autotune/state` exist.
   - Interpretation: likely no adaptive optimizer logic, only persisted state plumbing.
   - Follow-up: clarify wording in release notes (without changing runtime logic).

4. **Run download payload omission (`stats.json`) — RESOLVED**
   - Updated: run download now includes `stats.json` when present and parseable.

## Section 4 — RC Checklist (Consolidated)

### Minimum (automated)
1. `npm i`
2. `npm run rc:check`
3. `npm run rc:smoke`

### Extended automated
4. `npm --prefix backend test -- universeContractFilter.test.ts percentConvention.test.ts`
5. `npm --prefix backend test -- server.test.ts botEngine.test.ts replayService.test.ts profileService.test.ts`

### Manual critical
6. Universe create/refresh/get/download/clear flow.
7. Start/pause/resume/stop flow with snapshot behavior.
8. Kill flow: verify residual counters and final state.
9. Reset-all while running => reject.
10. Export pack when optional files missing => `meta.json` + notes.
11. Replay and record mutual exclusion.
12. UI tracked symbols: no impossible phase rows.

## Test coverage map

| Test file | Covered invariants/functions | Gap assessment |
|---|---|---|
| `backend/test/universeContractFilter.test.ts` | USDT linear perp filter rules (nonPerp/nonUSDT/expiring/nonLinear) | Good |
| `backend/test/universeService.test.ts` | Universe build/refresh/persist semantics | Partial on upstream chaos permutations |
| `backend/test/universeSymbol.test.ts` | Symbol normalization | Good |
| `backend/test/universeExclusionsService.test.ts` | Exclusions persistence add/remove/clear | Good |
| `backend/test/percentConvention.test.ts` | `%` convention + ROI leverage conversion | Good |
| `backend/test/botEngine.test.ts` | FSM, strategy flow, counters, lifecycle internals | Broad coverage, but kill residual hard guarantees not fully asserted |
| `backend/test/server.test.ts` | API route contracts, kill/reset/export/journal best-effort | Strong integration coverage |
| `backend/test/profileService.test.ts` | profiles CRUD/import normalization | Good |
| `backend/test/replayService.test.ts` | replay/record basic behavior and guards | Could add missing-file explicit error mapping |
| `backend/test/autoTuneService.test.ts` | autotune state persistence/history | Good |
| `backend/test/journalService.test.ts` | append/tail/clear/rotate basics | Could add rotate-failure observability test |
| `backend/test/marketHub.test.ts` | market hub update/subscription behavior | Good |
| `backend/test/qty.test.ts` | quantity normalization helpers | Good |
| `backend/test/bybitParsers.test.ts` | Bybit parser validation | Good |

### Critical test gaps (proposed)
- **P1**: deterministic kill post-condition strict test (`activeOrdersRemaining===0 && openPositionsRemaining===0`) across demo failure scenarios.
- **P1**: replay start with nonexistent file should return explicit `FILE_NOT_FOUND` (currently generic busy mapping).
- **P1**: run download payload should include `stats.json` when present (additive contract test).

## Command execution evidence (this audit run)
- `npm i` -> exit 0 (PASS)
- `npm run rc:check` -> exit 0 (PASS)
- `npm run rc:smoke` -> exit 0 (PASS, expected timeout shutdown behavior)

## How to verify
1. Re-run command block above and confirm exit codes.
2. Re-run manual critical checklist from this section.
3. Compare this matrix with code paths listed in Evidence column using `rg` + file inspection.

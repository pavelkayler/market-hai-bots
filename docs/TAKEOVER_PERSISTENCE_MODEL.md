# TAKEOVER_PERSISTENCE_MODEL

## Persistence inventory (v1)

## Core files under `backend/data/*`
- `universe.json` — universe state with filters, symbols, diagnostics, contract filter label.
- `runtime.json` — bot runtime snapshot (symbols FSM state, config, stats).
- `profiles.json` — profile registry + active profile.
- `journal.ndjson` — append-only journal events.
- `universe_exclusions.json` — current exclusions list.
- `universe_exclusions_<timestamp>.json` — historical exclusion snapshots.
- `runs/<runId>/meta.json`, `events.ndjson`, optional `stats.json`.
- `autotune/state.json` — autotune state and history.
- `replay/*.ndjson` — captured market replay streams.

## File owners
- Universe: `UniverseService`
- Snapshot: `FileSnapshotStore` + `BotEngine`
- Profiles: `ProfileService`
- Journal: `JournalService`
- Exclusions: `UniverseExclusionsService`
- Runs: `RunRecorderService`
- AutoTune: `AutoTuneService`
- Replay files: `ReplayService`

## Backward compatibility / additive behavior

### Profiles
- Import/load path validates each profile through `normalizeBotConfig`.
- Missing/legacy fields are default-injected by `normalizeBotConfig`.
- `default` profile auto-restored if missing.

### Runtime snapshots
- `restoreFromSnapshot` injects defaults for additive fields (e.g., signal/gates/bothCandidate/autotune fields).
- Unknown/legacy optional fields tolerated; missing additive fields normalized.

### Universe persisted state
- `UniverseService.get()` checks required derived fields (`contractFilter`, counters).
- If legacy data missing fields, service sanitizes + re-persists normalized state.

### Journal/run/autotune persistence robustness
- Journal rotate is best-effort (rotate failure does not abort append flow).
- Run recorder write failures are swallowed (no bot crash).
- AutoTune persist failures are swallowed (no bot crash).

## Export pack persistence integration
- Reads persisted files if present.
- `meta.json` always generated with notes/counts/paths.
- Operation remains successful even when optional artifacts are absent.

## Snapshot safety expectation
- Contract expectation: payloads additive, old snapshots/profiles loadable via normalization/default injection.
- Audit result: expectation mostly met for profiles/runtime/universe.

## How to verify
1. Remove optional fields from `profiles.json`/`runtime.json` manually, restart backend, verify startup succeeds and files normalized.
2. Verify universe sanitize path:
   - create legacy-like `universe.json` missing counters
   - call `GET /api/universe`
   - check persisted file rewritten with required fields.
3. Verify export robustness:
   - delete one or more files (e.g. journal/universe)
   - call `GET /api/export/pack`
   - inspect `meta.json.notes` for missing artifacts.
4. Verify run/autotune/journal best-effort behavior with failing filesystem mocks (covered in unit tests for server/journal/autoTune paths).

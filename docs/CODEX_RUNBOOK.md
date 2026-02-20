# CODEX_RUNBOOK (how Codex should work on this repo)

## Rules
1. Do NOT change UI layout/visuals. Only fix bindings, logic, data flow.
2. Do NOT add new features unless explicitly requested in the user's latest messages.
3. Work in small steps:
   - implement one coherent fix-set
   - run tests
   - update/extend tests
   - provide a concise changelog
4. Before coding: read these files in repo root:
   - PROJECT_SPEC.md
   - API_WS_CONTRACT.md
   - ROADMAP.md
   - TESTING_CHECKLIST.md

## Workflow (mandatory)
1. Identify target files & paths precisely.
2. Implement minimal fix.
3. Add or update tests that would fail before the fix.
4. Run:
   - backend: `npm test`
   - frontend: `npm test` (if exists) and `npm run build` (or `npm run dev` sanity)
5. Ensure no TypeScript compile errors.

## Output format
- Provide a step-by-step patch plan
- Provide a file list changed
- Provide commands executed
- Provide key log excerpts if relevant
- Do not hand-wave ("should work"); verify.

## Common pitfalls
- Snapshot fields must never be undefined.
- WS handler signature differs by @fastify/websocket version — ensure stable.
- Vite proxy must have single `server` block.
- Use stable keys in React tables (symbol/id, not array index).

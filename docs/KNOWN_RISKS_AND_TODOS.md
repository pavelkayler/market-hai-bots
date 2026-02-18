# KNOWN_RISKS_AND_TODOS

Ниже consolidated список ограничений/расхождений по code+docs с приоритетами.

## P0
1. **KILL residuals могут остаться ненулевыми (warning-only), hard-fail нет.**
   - Причина: сервер формирует warning, но всегда возвращает `ok:true` и завершает stop flow.
   - Где видно: `backend/src/server.ts` (`/api/bot/kill` warning logic).
   - Риск: оператор может считать flatten полностью завершенным при остаточных позициях/ордерах.

## P1
2. **`docs/TASKS.md` не синхронизирован с фактической реализацией (много unchecked пунктов уже реализованы).**
   - Причина: документ stale, может вводить takeover-команду в заблуждение.
   - Где видно: `docs/TASKS.md` vs фактические маршруты/сервисы в `backend/src/server.ts`.

3. **`docs/QA_REPORT_LATEST.md` содержит шаблонные placeholders вместо фактического последнего прогона.**
   - Причина: файл выглядит как run log, но заполнен `<PASS|FAIL>`.
   - Где видно: `docs/QA_REPORT_LATEST.md`.

4. **Release note утверждает “No ML/autotune/optimizer in v1”, но autotune state и API реализованы.**
   - Причина: терминологический drift (вероятно имелось “no adaptive optimization logic”, но persisted autotune subsystem есть).
   - Где видно: `docs/RELEASE_NOTES_v1.md` + `backend/src/services/autoTuneService.ts` + `GET /api/autotune/state`.

5. **Run payload download не включает `stats.json` даже если он существует.**
   - Причина: `RunRecorderService.getRunPayload` возвращает только `meta.json` + `events.ndjson`.
   - Где видно: `backend/src/services/runRecorderService.ts`.

6. **Replay start не валидирует существование файла до чтения stream на уровне явной API ошибки.**
   - Причина: ошибки чтения уходят в generic `REPLAY_BUSY` на route уровне.
   - Где видно: `backend/src/server.ts` replay start catch + `backend/src/replay/replayService.ts`.

## P2
7. **Journal rotate failure silently ignored (design choice), оператор не получает явного сигнала деградации.**
   - Причина: `rotateIfNeeded` swallow исключения.
   - Где видно: `backend/src/services/journalService.ts`.

8. **Run recorder write failures swallow without telemetry escalation.**
   - Причина: append/writeStats catch ignore.
   - Где видно: `backend/src/services/runRecorderService.ts`.

9. **Autotune persistence failures swallow without operator-level alert.**
   - Причина: persist catches all.
   - Где видно: `backend/src/services/autoTuneService.ts`.

10. **UI lifecycle normalizes impossible symbol states client-side, что маскирует upstream/FSM inconsistencies вместо явного alert.**
    - Причина: BotPage принудительно rewrites state when `position/pendingOrder` disagree with state.
    - Где видно: `frontend/src/pages/BotPage.tsx` trackedSymbols mapping.

## Imported limitations from existing docs
- Demo close detection based on polling heuristic (`docs/TASKS.md`, `docs/RELEASE_NOTES_v1.md`).
- Paper fee assumptions pending explicit authoritative confirmation (`docs/TASKS.md`).
- Replay quality depends on recorded data density (`docs/RELEASE_NOTES_v1.md`).

## How to verify
1. Проверить документальные расхождения:
   - `cat docs/TASKS.md`
   - `cat docs/QA_REPORT_LATEST.md`
   - `cat docs/RELEASE_NOTES_v1.md`
2. Проверить code evidence:
   - `rg -n "kill|warning|activeOrdersRemaining|openPositionsRemaining" backend/src/server.ts backend/src/bot/botEngine.ts`
   - `rg -n "getRunPayload|writeStats|catch \{" backend/src/services/runRecorderService.ts`
   - `rg -n "rotateIfNeeded|catch" backend/src/services/journalService.ts`
3. Проверить replay error mapping вручную с несуществующим файлом.

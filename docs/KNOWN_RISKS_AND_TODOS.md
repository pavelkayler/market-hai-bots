# KNOWN_RISKS_AND_TODOS

Ниже consolidated список ограничений/расхождений по code+docs с приоритетами.

## P0
1. **DEMO close accounting and KILL reliability improved (downgraded risk).**
   - Что исправлено: demo KILL повторяет close при необходимости и ждёт подтверждение дольше; hedge-mode `positionIdx` mismatch обрабатывается retry на клиенте.
   - Что осталось: endpoint `/v5/position/closed-pnl` best-effort, поэтому при его деградации используется fallback по mark-price math.

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

5. **Run payload gap `stats.json` — RESOLVED.**
   - Что исправлено: `getRunPayload` добавляет `stats.json` при наличии и валидном JSON; route download кладёт файл в zip.
   - Где видно: `backend/src/services/runRecorderService.ts`, `backend/src/server.ts`, `backend/test/server.test.ts`.

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
- Paper fee/slippage/spread accounting model aligned with `docs/SETTINGS_GUIDE.md` and covered by `backend/test/pnlMath.test.ts` + `backend/test/botEngine.test.ts` (RESOLVED for current paper model).
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

- Entry without price/qty is now blocked by explicit validation in paper fill and demo payload paths; residual risk only for upstream exchange anomalies outside local validation.
# TAKEOVER_SETTINGS_SCHEMA

## Source of truth
- Backend validation/defaulting: `backend/src/bot/botEngine.ts` (`normalizeBotConfig`)
- Default/operator presets: `backend/src/services/profileService.ts`
- Frontend form/types: `frontend/src/types.ts`, `frontend/src/pages/BotPage.tsx`

## Percent convention (critical)
- Конвенция проекта: `3` means `3%`, НЕ `0.03`.
- Проверяется тестом `backend/test/percentConvention.test.ts`.

## Settings groups

### Execution mode + direction
- `mode`: `paper | demo`
- `direction`: `long | short | both`
- `bothTieBreak`: `shortPriority | longPriority | strongerSignal`
- `tf`: `1 | 3 | 5` (minutes)

### Strategy thresholds (percent units)
- `priceUpThrPct`: number
- `oiUpThrPct`: number
- `oiCandleThrPct`: `>=0`
- `trendMinMovePct`: `>=0`
- `confirmMinContinuationPct`: `>=0`
- `entryOffsetPct`: `>=0`

### Risk/capital
- `marginUSDT`: `>0`
- `leverage`: `>0`
- `tpRoiPct`: `>0`
- `slRoiPct`: `>0`
- `minNotionalUSDT`: `>=0`

### Counters/windows
- `signalCounterThreshold`: int `>=1`
- `signalCounterMin`: int `>=1`
- `signalCounterMax`: int `>= signalCounterMin`
- `confirmWindowBars`: int `[1..5]`
- `impulseMaxAgeBars`: int `[1..10]`
- `trendLookbackBars`: int `[10..200]`
- `maxSecondsIntoCandle`: int `>=0`

### Guardrails
- `maxActiveSymbols`: int `>=1`
- `dailyLossLimitUSDT`: `>=0`
- `maxConsecutiveLosses`: int `>=0`
- `minSpreadBps`: `>=0`
- `maxSpreadBps`: `>=0`
- `maxTickStalenessMs`: int `>=0`

### AutoTune / paper model
- `autoTuneEnabled`: boolean
- `autoTuneScope`: `GLOBAL | UNIVERSE_ONLY`
- `paperEntrySlippageBps`: `>=0`
- `paperExitSlippageBps`: `>=0`
- `paperPartialFillPct`: `[0..100]`

## Math notes (audit-critical)

### ROI / leverage conversion
- Engine uses `percentToFraction(roiPct / leverage)` for TP/SL move fraction.
- Это строго соответствует конвенции процентов (input in `%`, divide by leverage, then `/100`).

### entryOffsetPct formula
- Entry limit uses `off = max(0, entryOffsetPct)` as percent unit.
- Directional application:
  - LONG entry limit below trigger mark by `off%`.
  - SHORT entry limit above trigger mark by `off%`.

### OI candle gates
- `oiCandleThrPct` используется как threshold на candle-based OI delta gate.
- `requireOiTwoCandles=true` включает дополнительный 2-candle gating requirement.

### signalCounter range/threshold
- `signalCounterThreshold` исторически поддерживается.
- Runtime gating фактически использует диапазон `signalCounterMin..signalCounterMax`.

## Operator presets (from profiles)
- `default` — базовый paper профиль.
- `fast_test_1m` — ускоренный 1m smoke-style.
- `overnight_1m_safe` — более консервативный overnight.
- `smoke_min_1m` / `smoke_min_thresholds_1m` — минимальные smoke thresholds.

## How to verify
1. Проверить normalization bounds через unit tests:
   - `npm --prefix backend test -- botEngine.test.ts`
   - `npm --prefix backend test -- percentConvention.test.ts`
2. Проверить presets через `GET /api/profiles` + `GET /api/profiles/:name`.
3. В UI BotPage проверить help text/inputs для `%` полей и range constraints.
4. Подтвердить ROI math в коде: `rg -n "tpRoiPct|slRoiPct|percentToFraction\(" backend/src/bot/botEngine.ts`.

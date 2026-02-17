# SETTINGS GUIDE — практическое руководство (PAPER/DEMO)

Этот документ объясняет, как настраивать бота для стабильного PAPER-тестирования и аккуратного перехода в DEMO.

Важно по форматам процентов: процентные поля вводятся как **"3" = 3%**, а не `0.03`.

## 1) Фильтры Universe

### `minTurnover`
Минимальный оборот за 24ч в USDT (`turnover24hUSDT`).

Типичные значения:
- **10M** — широкий охват, больше «шума».
- **25M** — сбалансированный вариант.
- **50M** — только самые ликвидные инструменты.

Практика: если слишком много случайных входов, сначала повышайте `minTurnover`, а не пороги сигнала.

### `minVolPct`
Волатильность за 24ч в процентах:

`vol24hPct = (highPrice24h - lowPrice24h) / lowPrice24h * 100`

Типичные значения:
- **5–8%** — более спокойный отбор.
- **10–15%** — базовый режим для скальп-проверок.
- **20%+** — только сильно двигающиеся пары.

## 2) Режимы работы

### `paper`
- Локальное исполнение LIMIT@mark.
- Максимально быстрый цикл теста.
- Не зависит от demo-ключей.

### `demo`
- Реальные REST-запросы на `api-demo.bybit.com`.
- Ближе к реальной среде (задержки/очередь/статусы биржи).
- Требует `DEMO_API_KEY` и `DEMO_API_SECRET`.

## 3) Направление (`direction`)

- `long` — только LONG.
- `short` — только SHORT.
- `both` — оба направления.

Важно: в режиме `both` при одновременном совпадении сигналов действует приоритет **SHORT**.

## 4) Таймфрейм (`tf`)

Допустимые значения: `1`, `3`, `5` минут.

Проверка новых сигналов из `IDLE` запускается только на UTC-границах выбранного шага (например, для `tf=5`: 00, 05, 10, ...).
После reset baseline (cancel/close) действует override — следующая оценка может стартовать сразу.

## 5) `holdSeconds`

Сколько секунд условие должно оставаться истинным непрерывно перед постановкой входа.

- Меньше значение → быстрее вход, но больше шумовых срабатываний.
- Больше значение → выше подтверждение, но возможен пропуск резкого импульса.

Стартовые ориентиры:
- 2–3 сек для активного paper-скальпа.
- 4–6 сек для более консервативного режима.

## 6) Пороги сигналов

### `priceUpThrPct`
Для LONG: минимальный рост цены (mark) относительно baseline.

### `oiUpThrPct`
Для LONG: минимальный рост OI (`openInterestValue`) относительно baseline.
По умолчанию — **50%**.

Расчёт:
- `priceDeltaPct = (markNow - basePrice) / basePrice * 100`
- `oiDeltaPct = (oiNow - baseOiValue) / baseOiValue * 100`

Примеры:
1. База: `basePrice=100`, `baseOi=1000`, сейчас `mark=100.8`, `oi=1550` → `priceDelta=0.8%`, `oiDelta=55%`.
   При `priceUpThrPct=0.5`, `oiUpThrPct=50` LONG-условие истинно.
2. База: `basePrice=100`, `baseOi=1000`, сейчас `mark=100.6`, `oi=1200` → `0.6%` и `20%`.
   LONG не подтверждён из-за OI.
3. Для SHORT пороги по модулю не нужны: достаточно `priceDeltaPct < 0` и `oiDeltaPct < 0`.

## 7) Параметры риска

### `marginUSDT`, `leverage`
- `marginUSDT` — размер маржи на сделку.
- `leverage` — плечо.

### `tpRoiPct`, `slRoiPct`
ROI-цели для TP/SL конвертируются в движение цены через плечо:

`priceMovePct = ROI% / leverage`

Пример:
- `leverage=10`, `tpRoiPct=1%` → требуется движение цены примерно `0.1%`.
- `leverage=10`, `slRoiPct=0.7%` → стоп около `0.07%`.

### `entryOffsetPct`
Смещение лимитной цены входа от mark:

- LONG: `entryLimit = mark * (1 - entryOffsetPct / 100)`
- SHORT: `entryLimit = mark * (1 + entryOffsetPct / 100)`

Примеры:
- `x=0.01` → offset `0.01%`
- `x=0.1` → offset `0.1%`

## 8) Guardrails

### `maxActiveSymbols`
Максимум одновременно активных символов в `ENTRY_PENDING` + `POSITION_OPEN`.

### `dailyLossLimitUSDT`
Если дневной PnL (UTC) падает до `<= -limit`, бот автоматически ставится на pause.

### `maxConsecutiveLosses`
При достижении лимита серии убыточных закрытий — auto-pause.

### KILL switch
`/api/bot/kill`:
- ставит бота на паузу,
- отменяет все pending entry,
- **не** закрывает уже открытые позиции.

## 9) Профили

Поддерживаются save/load и выбор активного профиля:
- `POST /api/profiles/save`
- `GET /api/profiles/get?name=...`
- `POST /api/profiles/set-active`
- import/export: `GET /api/profiles/download` и `POST /api/profiles/upload`

Если запускать `/api/bot/start` без тела, используется активный профиль.

## 10) Рекомендуемые стартовые пресеты

### Conservative paper test
- `mode=paper`
- `direction=long`
- `tf=3`
- `holdSeconds=4`
- `priceUpThrPct=0.7`
- `oiUpThrPct=50`
- `marginUSDT=50`
- `leverage=5`
- `tpRoiPct=0.8`
- `slRoiPct=0.6`
- `maxActiveSymbols=2`

### Aggressive scalping paper
- `mode=paper`
- `direction=both`
- `tf=1`
- `holdSeconds=2`
- `priceUpThrPct=0.4`
- `oiUpThrPct=50`
- `marginUSDT=100`
- `leverage=10`
- `tpRoiPct=1.0`
- `slRoiPct=0.7`
- `maxActiveSymbols=5`

### Demo-safe
- `mode=demo`
- `direction=long`
- `tf=3`
- `holdSeconds=4`
- `priceUpThrPct=0.6`
- `oiUpThrPct=50`
- `marginUSDT=25`
- `leverage=3`
- `tpRoiPct=0.8`
- `slRoiPct=0.6`
- `maxActiveSymbols=1`
- `dailyLossLimitUSDT=10`
- `maxConsecutiveLosses=2`

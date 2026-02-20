# API & WS Contract (paper bot)

## Backend base
- HTTP: `http://localhost:8080`
- WS: `ws://localhost:8080/ws`

## Frontend dev proxy (Vite)
Frontend в dev работает на `http://localhost:5173` и должен использовать **same-origin** пути:
- `/api/...`
- `/ws`

Vite proxy обязан пробрасывать на backend:
- `/api` -> `http://localhost:8080`
- `/ws` -> `http://localhost:8080` (ws upgrade)

---

## WebSocket

### Client -> Server messages (JSON)
All messages must be JSON with `type`.

- `PING`  
  `{ "type": "PING", "clientTimeMs": number }`

- `REFRESH_SNAPSHOT`  
  `{ "type": "REFRESH_SNAPSHOT" }`

- `REFRESH_SIGNALS`  
  `{ "type": "REFRESH_SIGNALS" }`

- `SET_BOT_RUN_STATE`  
  `{ "type": "SET_BOT_RUN_STATE", "state": "RUNNING" | "STOPPED" }`

- `KILL_ALL`  
  `{ "type": "KILL_ALL" }`

- `RESET_ALL`  
  `{ "type": "RESET_ALL" }`

- `SET_UNIVERSE_CONFIG`  
  `{ "type": "SET_UNIVERSE_CONFIG", "config": UniverseConfig }`

- `REBUILD_UNIVERSE`  
  `{ "type": "REBUILD_UNIVERSE" }`

- `SAVE_UNIVERSE_PRESET`  
  `{ "type": "SAVE_UNIVERSE_PRESET", "name"?: string }`

- `REMOVE_UNIVERSE_SYMBOL`  
  `{ "type": "REMOVE_UNIVERSE_SYMBOL", "symbol": string }`

### Server -> Client messages (JSON)
- `SNAPSHOT`  
  `{ "type": "SNAPSHOT", "snapshot": Snapshot }`

- `PONG`  
  `{ "type": "PONG", "serverTimeMs": number, "clientTimeMs": number }`

- `ACK`  
  `{ "type": "ACK", "ok": true, "requestType": string }`

- `ERROR`  
  `{ "type": "ERROR", "ok": false, "message": string, "requestType"?: string }`

### Snapshot invariants
`Snapshot` must ALWAYS contain these fields (never `undefined` — empty arrays/objects allowed):

- `serverTimeMs: number`
- `botRunState: "RUNNING" | "STOPPED" | "KILLED"`
- `backendBybitWs: { status: "CONNECTED"|"DISCONNECTED", lastHeartbeatMs?: number }` (or equivalent)
- `universeConfig: UniverseConfig`
- `universe: { totalSymbols: number, selectedSymbols: number }`
- `currentUniverseName: string | null`
- `savedUniverses: Array<UniversePreset>`
- `symbols: Array<SymbolMetricsRow>`
- `signalRows: Array<SignalRow>`
- `openOrders: Array<PaperOrder>`
- `openPositions: Array<PaperPosition>`
- `tradeHistory: Array<Trade>`
- `tradeResultsBySymbol: Array<SymbolResultsRow>`
- `feeSummary: { totalFeesUsd: number, ... }` (или эквивалент агрегата)

Backend должен broadcast-ить snapshot:
- при любом изменении состояния Store
- при любой кнопке/команде
- по таймеру (если включено) но без спама (обычно 1/sec достаточно)

---

## REST endpoints (utility)
- `GET /api/usdt-symbols` -> `{ symbols: string[] }`
- `POST /api/requests/run` `{ symbol }` -> `{ websocket: Array<{name,response}>, api: Array<{name,response}> }`

Requests page НЕ должна зависеть от WS frontend<->backend.

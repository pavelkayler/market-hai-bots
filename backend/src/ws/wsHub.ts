import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../domain/contracts.js";
import { BybitRest } from "../bybit/bybitRest.js";
import { buildUniverse } from "../universe/universeBuilder.js";
import { defaultUniverseName } from "../universe/universeName.js";
import { removeUniverseSymbol } from "../universe/removeSymbol.js";
import { killAll } from "../paper/killAll.js";
import type { Store } from "../state/store.js";
import { resetStore } from "../state/store.js";

/**
 * WS hub: frontend <-> backend.
 * Route: GET /ws (websocket upgrade)
 */
export function registerWsHub(app: FastifyInstance, store: Store, opts?: { onUniverseRebuilt?: (symbols: string[]) => void }) {
  const rest = new BybitRest({
    baseUrl: process.env.BYBIT_REST_BASE_URL ?? "https://api.bybit.com",
    timeoutMs: Number(process.env.BYBIT_REST_TIMEOUT_MS ?? 8000),
  });

  const clients = new Set<WebSocket>();

  const broadcastSnapshot = () => {
    const snap: ServerMessage = { type: "SNAPSHOT", snapshot: store.snapshot() };
    const raw = JSON.stringify(snap);
    for (const c of clients) {
      try {
        c.send(raw);
      } catch {
        // ignore
      }
    }
  };

  app.get("/ws", { websocket: true }, (conn: any, _req: any) => {
    const socket = (conn?.socket ?? conn) as WebSocket;
    clients.add(socket);

    // On connect: push snapshot
    try {
      const msg: ServerMessage = { type: "SNAPSHOT", snapshot: store.snapshot() };
      socket.send(JSON.stringify(msg));
    } catch {
      // ignore
    }

    socket.on("close", () => {
      clients.delete(socket);
    });

    socket.on("error", () => {
      clients.delete(socket);
    });

    socket.on("message", async (raw) => {
      try {
        const parsed = JSON.parse(raw.toString()) as ClientMessage;

        if (parsed.type === "PING") {
          const pong: ServerMessage = { type: "PONG", serverTimeMs: Date.now(), clientTimeMs: parsed.clientTimeMs };
          socket.send(JSON.stringify(pong));
          return;
        }

        if (parsed.type === "REFRESH_SIGNALS") {
          store.forceSignalsRefresh();
          broadcastSnapshot();
          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          return;
        }

        if (parsed.type === "REFRESH_SNAPSHOT") {
          const snap: ServerMessage = { type: "SNAPSHOT", snapshot: store.snapshot() };
          socket.send(JSON.stringify(snap));
          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          return;
        }

        if (parsed.type === "SET_UNIVERSE_CONFIG") {
          store.universeConfig = parsed.config;
          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        if (parsed.type === "REBUILD_UNIVERSE") {
          try {
            const res = await buildUniverse({ rest, config: store.universeConfig });
            store.universe.totalSymbols = res.totalEligibleSymbols;
            store.universe.selectedSymbols = res.selectedSymbols.length;
            store.symbols = res.symbolMetrics;

            if (opts?.onUniverseRebuilt) opts.onUniverseRebuilt(res.selectedSymbols);

            const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
            socket.send(JSON.stringify(ack));
            broadcastSnapshot();
          } catch (e: any) {
            const err: ServerMessage = { type: "ERROR", ok: false, message: e?.message ?? "Universe build failed", requestType: parsed.type };
            socket.send(JSON.stringify(err));
          }
          return;
        }

        if (parsed.type === "SAVE_UNIVERSE_PRESET") {
          const nameRaw = (parsed.name ?? "").trim();
          const name = nameRaw.length > 0 ? nameRaw : defaultUniverseName(store.universeConfig);

          const res = await buildUniverse({ rest, config: store.universeConfig });
          store.universe.totalSymbols = res.totalEligibleSymbols;
          store.universe.selectedSymbols = res.selectedSymbols.length;
          store.symbols = res.symbolMetrics;
          store.currentUniverseName = name;

          const preset = {
            name,
            createdAtMs: Date.now(),
            config: { ...store.universeConfig },
            symbols: res.selectedSymbols,
          };

          const i = store.savedUniverses.findIndex((p) => p.name === name);
          if (i >= 0) store.savedUniverses[i] = preset;
          else store.savedUniverses.push(preset);

          if (opts?.onUniverseRebuilt) opts.onUniverseRebuilt(res.selectedSymbols);

          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        if (parsed.type === "REMOVE_UNIVERSE_SYMBOL") {
          removeUniverseSymbol({
            symbol: parsed.symbol,
            symbols: store.symbols,
            openOrders: store.openOrders,
            openPositions: store.openPositions,
            tradeHistory: store.tradeHistory,
            savedUniverses: store.savedUniverses,
            currentUniverseName: store.currentUniverseName,
          });
          store.universe.selectedSymbols = store.symbols.length;

          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        if (parsed.type === "SET_BOT_RUN_STATE") {
          store.botRunState = parsed.state;

          // On STOP -> cancel all OPEN paper orders; positions remain.
          if (parsed.state === "STOPPED") {
            for (const o of store.openOrders) {
              if (o.status === "OPEN") o.status = "CANCELLED";
            }
            for (const s of store.symbols) {
              if (s.status === "ORDER_PLACED") {
                s.status = "WAITING_TRIGGER";
                s.reason = "bot stopped; order cancelled";
              }
            }
          }

          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        if (parsed.type === "KILL_ALL") {
          killAll({
            nowMs: Date.now(),
            symbols: store.symbols,
            openOrders: store.openOrders,
            openPositions: store.openPositions,
            tradeHistory: store.tradeHistory,
          });
          store.botRunState = "KILLED";

          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        if (parsed.type === "RESET_ALL") {
          resetStore(store);
          const ack: ServerMessage = { type: "ACK", ok: true, requestType: parsed.type };
          socket.send(JSON.stringify(ack));
          broadcastSnapshot();
          return;
        }

        const err: ServerMessage = { type: "ERROR", ok: false, message: "Unknown message type", requestType: (parsed as any).type };
        socket.send(JSON.stringify(err));
      } catch (e: any) {
        const err: ServerMessage = { type: "ERROR", ok: false, message: e?.message ?? "Bad message" };
        try {
          socket.send(JSON.stringify(err));
        } catch {
          // ignore
        }
      }
    });
  });
}

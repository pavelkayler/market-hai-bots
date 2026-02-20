import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createStore } from "../state/store.js";
import { registerWsHub } from "./wsHub.js";

async function openClient() {
  const app = Fastify();
  await app.register(websocket);
  const store = createStore();
  registerWsHub(app, store);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: any[] = [];
  ws.on("message", (raw) => {
    inbox.push(JSON.parse(raw.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { app, store, ws, inbox };
}

function waitForType(ws: WebSocket, inbox: any[], type: string) {
  const existing = inbox.find((m) => m.type === type);
  if (existing) return Promise.resolve(existing);

  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${type}`)), 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition timeout");
}

describe("wsHub", () => {
  afterEach(() => {
    // no-op; each test closes app explicitly
  });

  it("sends snapshot on connect and responds to ping", async () => {
    const { app, ws, inbox } = await openClient();
    const snap = await waitForType(ws, inbox, "SNAPSHOT");
    expect(snap.snapshot).toBeTruthy();

    ws.send(JSON.stringify({ type: "PING", clientTimeMs: 123 }));
    const pong = await waitForType(ws, inbox, "PONG");
    expect(pong.clientTimeMs).toBe(123);

    ws.close();
    await app.close();
  });

  it("STOP cancels open orders and KILL closes positions", async () => {
    const { app, ws, store, inbox } = await openClient();
    await waitForType(ws, inbox, "SNAPSHOT");

    store.openOrders.push({ id: "o1", symbol: "BTCUSDT", side: "Buy", entryPrice: 100, createdAtMs: Date.now(), status: "OPEN" });
    store.openPositions.push({ id: "p1", symbol: "BTCUSDT", side: "Long", entryPrice: 100, qty: 1, marginUSDT: 100, leverage: 10, openedAtMs: Date.now(), status: "OPEN" });
    store.symbols.push({ symbol: "BTCUSDT", markPrice: 100, priceDeltaPct: 0, oiValue: 0, oiDeltaPct: 0, fundingRate: 0, fundingTimeMs: 0, nextFundingTimeMs: Date.now() + 100000, status: "ORDER_PLACED", reason: "", triggerCountToday: 0 });

    ws.send(JSON.stringify({ type: "SET_BOT_RUN_STATE", state: "STOPPED" }));
    await waitFor(() => inbox.some((m) => m.type === "ACK" && m.requestType === "SET_BOT_RUN_STATE"));
    expect(store.openOrders[0].status).toBe("CANCELLED");
    expect(store.openPositions[0].status).toBe("OPEN");

    ws.send(JSON.stringify({ type: "KILL_ALL" }));
    await waitFor(() => inbox.some((m) => m.type === "ACK" && m.requestType === "KILL_ALL"));
    expect(store.botRunState).toBe("KILLED");
    expect(store.openPositions[0].status).toBe("CLOSED");

    ws.close();
    await app.close();
  });
});

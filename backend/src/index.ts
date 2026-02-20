import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createStore } from "./state/store.js";
import { makeInitialSymbols, tickSymbols } from "./mock/mockFeed.js";
import { BybitRest } from "./bybit/bybitRest.js";
import { buildUniverse } from "./universe/universeBuilder.js";
import { SymbolCandleManager } from "./market/symbolCandleManager.js";
import { TriggerEngine } from "./strategy/triggerEngine.js";
import { PaperMatcher } from "./paper/paperMatcher.js";
import { registerWsHub } from "./ws/wsHub.js";
import { BybitWsClient } from "./bybit/bybitWsClient.js";
import { BybitTickerStream } from "./bybit/tickerStream.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const app = Fastify({ logger: true });
  await app.register(websocket);

  const store = createStore();
  const candleMgr = new SymbolCandleManager(store.botConfig.timeframe);
  const triggerEngine = new TriggerEngine();
  const paperMatcher = new PaperMatcher();
    store.universe.totalSymbols = 0;
    store.universe.selectedSymbols = 0;
  store.backendToBybit = "DISCONNECTED"; // Step 1: no real Bybit WS yet
  store.symbols = makeInitialSymbols();
  store.onUniverseRebuilt = (symbols) => tickerStream.setSymbols(symbols);

// Universe Builder (Step 3): build once at startup (best-effort)
const rest = new BybitRest({
  baseUrl: process.env.BYBIT_REST_BASE_URL ?? "https://api.bybit.com",
  timeoutMs: Number(process.env.BYBIT_REST_TIMEOUT_MS ?? 8000),
});

buildUniverse({ rest, config: store.universeConfig })
  .then((res) => {
    store.universe.totalSymbols = res.totalEligibleSymbols;
    store.universe.selectedSymbols = res.selectedSymbols.length;
    store.universe.symbols = res.selectedSymbols;
    store.symbols = res.symbolMetrics;
    app.log.info(`[universe] built: selected=${res.selectedSymbols.length} eligible=${res.totalEligibleSymbols}`);
  })
  .catch((e) => {
    app.log.warn(`[universe] build failed: ${String((e as any)?.message ?? e)}`);
  });


// Step 2: Bybit WS connectivity scaffold (public linear)
const BYBIT_PUBLIC_WS = process.env.BYBIT_PUBLIC_WS ?? "wss://stream.bybit.com/v5/public/linear";
const tickerStream = new BybitTickerStream(
  // ws client assigned below
  null as any,
  {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  }
);

const bybitClient = new BybitWsClient(
  {
    url: BYBIT_PUBLIC_WS,
    pingIntervalMs: Number(process.env.BYBIT_PING_INTERVAL_MS ?? 20_000),
    reconnectBaseDelayMs: Number(process.env.BYBIT_RECONNECT_BASE_DELAY_MS ?? 500),
    reconnectMaxDelayMs: Number(process.env.BYBIT_RECONNECT_MAX_DELAY_MS ?? 30_000),
    logger: {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
      error: (m) => app.log.error(m),
    },
  },
  (status) => {
    store.backendToBybit = status;
  },
  (msg) => tickerStream.onMessage(msg),
  () => tickerStream.onOpen()
);

// patch circular dependency
(tickerStream as any).ws = bybitClient;


bybitClient.start();

// Graceful shutdown
const shutdown = async () => {
  bybitClient.stop();
  try {
    await app.close();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);


  // Simple health endpoint
  app.get("/health", async () => ({
    ok: true,
    serverTimeMs: Date.now(),
    backendToBybit: store.backendToBybit,
    botRunState: store.botRunState,
  }));

  let broadcastSnapshot: (() => void) | null = null;
  // WS hub
  registerWsHub(app, store, {
    onUniverseRebuilt: (syms) => {
      candleMgr.resetSymbols(syms);
      triggerEngine.resetSymbols(syms);
      tickerStream.setSymbols(syms);
    },
    onReady: (b) => {
      broadcastSnapshot = b;
    },
  });

  setInterval(() => {
    broadcastSnapshot?.();
  }, 1000);

  // CANDLE/DELTA LOOP (Step 5): backend computes deltas each 1s based on selected timeframe
  setInterval(() => {
    candleMgr.setTimeframe(store.botConfig.timeframe);
    const now = Date.now();
    if (store.botRunState !== "RUNNING") {
      // STOPPED or KILLED: do not update candles/triggers/paper matching
      return;
    }

    for (const s of store.symbols) {
      const eng = candleMgr.get(s.symbol);
      const oi = Number.isFinite(s.oiValue) ? s.oiValue : 0;
      const out = eng.push({ tsMs: now, price: s.markPrice, oiValue: oi });
      const prevClose = out.prev.prevClose;
      const prevOi = out.prev.prevOiClose;
      if (prevClose === undefined || prevClose <= 0) {
        s.priceDeltaPct = 0;
        s.oiDeltaPct = 0;
        s.status = "WAITING_CANDLE";
        s.reason = "waiting previous candle";
        continue;
      }
      s.priceDeltaPct = ((s.markPrice - prevClose) / prevClose) * 100;
      if (prevOi !== undefined && prevOi > 0) s.oiDeltaPct = ((oi - prevOi) / prevOi) * 100;
      else s.oiDeltaPct = 0;
      if (s.status === "WAITING_CANDLE") {
        s.status = "WAITING_TRIGGER";
        s.reason = "waiting trigger";
      } else if (s.status === "WAITING_TRIGGER") {
        s.reason = "waiting trigger";
      }

// Step 6: triggers + per-symbol state machine to ORDER_PLACED
triggerEngine.step({
  nowMs: now,
  botConfig: store.botConfig,
  botRunning: store.botRunState === "RUNNING",
  symbol: s,
  openOrders: store.openOrders,
});
    }
  }, 1000);

  // Tick loop (1s): update mock metrics
  // Tick loop (1s):
// - If Universe not built yet -> animate mock symbols
// - If Universe built -> apply latest Bybit ticker stream values at 1s cadence
setInterval(() => {
  if (store.universe.selectedSymbols === 0) {
    if (store.symbols.length <= 10) store.symbols = tickSymbols(store.symbols);
    return;
  }
  if (store.botRunState !== "KILLED") {
    store.symbols = tickerStream.applyToSymbols(store.symbols);
  }
}, 1000);


  // Requests page: list USDT perpetual symbols
  app.get("/api/usdt-symbols", async () => {
    const symbols = await rest.listUsdtPerpSymbols();
    return { symbols };
  });
  
  // Requests page: run a fixed set of WS+REST queries for a chosen symbol
  app.post("/api/requests/run", async (req, reply) => {
    const body: any = (req as any).body ?? {};
    const symbol = String(body.symbol ?? "");
    if (!symbol || !symbol.endsWith("USDT")) {
      reply.code(400);
      return { error: "symbol must be a USDT perpetual symbol" };
    }
  
    const sym = store.getSymbol(symbol);
  
    const websocket = [
      {
        name: `WS subscribe: tickers.${symbol}`,
        response: sym ? { topic: `tickers.${symbol}`, data: sym } : { error: "symbol not tracked by live pipeline (not in Universe)" },
      },
      {
        name: "WS data: funding (from tickers cache)",
        response: sym ? { fundingRate: sym.fundingRate, nextFundingTimeMs: sym.nextFundingTimeMs } : { error: "symbol not tracked by live pipeline" },
      },
      {
        name: "WS data: openInterest value (from cache)",
        response: sym ? { oiValue: sym.oiValue } : { error: "symbol not tracked by live pipeline" },
      },
    ];
  
    const api: any[] = [];
    const safeCall = async (name: string, fn: () => Promise<any>) => {
      try {
        api.push({ name, response: await fn() });
      } catch (e: any) {
        api.push({ name, response: { error: String(e?.message ?? e) } });
      }
    };
  
    await safeCall("REST: /v5/market/tickers", () => rest.getTicker(symbol));
    await safeCall("REST: /v5/market/instruments-info", () => rest.getInstrumentsInfo(symbol));
    await safeCall("REST: /v5/market/funding/history (limit=1)", () => rest.getFundingRate(symbol));
    await safeCall("REST: /v5/market/open-interest (5min, limit=1)", () => rest.getOpenInterest(symbol));
    await safeCall("REST: /v5/market/kline (1m, limit=2)", () => rest.getKline(symbol, "1", "2"));
  
    return { symbol, websocket, api };
  });
  

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`backend listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
})

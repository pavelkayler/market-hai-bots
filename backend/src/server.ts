import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import JSZip from 'jszip';

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { BotEngine, normalizeBotConfig } from './bot/botEngine.js';
import { FileSnapshotStore } from './bot/snapshotStore.js';
import { DemoTradeClient, type IDemoTradeClient } from './bybit/demoTradeClient.js';
import { MarketHub } from './market/marketHub.js';
import type { TickerStream } from './market/tickerStream.js';
import { ReplayService, type ReplaySpeed } from './replay/replayService.js';
import { BybitMarketClient, type IBybitMarketClient } from './services/bybitMarketClient.js';
import { JournalService, type JournalEntry } from './services/journalService.js';
import { ProfileService } from './services/profileService.js';
import { ActiveSymbolSet, UniverseService } from './services/universeService.js';
import { UniverseExclusionsService } from './services/universeExclusionsService.js';
import { SymbolUpdateBroadcaster, type SymbolUpdateMode } from './ws/symbolUpdateBroadcaster.js';
import type { UniverseEntry } from './types/universe.js';

type BuildServerOptions = {
  marketClient?: IBybitMarketClient;
  universeFilePath?: string;
  runtimeSnapshotFilePath?: string;
  activeSymbolSet?: ActiveSymbolSet;
  tickerStream?: TickerStream;
  now?: () => number;
  demoTradeClient?: IDemoTradeClient;
  wsClients?: Set<{ send: (payload: string) => unknown }>;
  journalFilePath?: string;
  profileFilePath?: string;
  universeExclusionsFilePath?: string;
};

const marketHubByApp = new WeakMap<FastifyInstance, MarketHub>();

export function getMarketHub(app: FastifyInstance): MarketHub {
  const marketHub = marketHubByApp.get(app);
  if (!marketHub) {
    throw new Error('MarketHub is not registered for this app instance');
  }

  return marketHub;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const startedAtMs = Date.now();
  const perfWindowMs = 5000;
  let perfWindowStartedAtMs = Date.now();
  let tickHandlerTotalMs = 0;
  let tickHandlerCount = 0;
  let wsFramesSent = 0;
  let evalRunCount = 0;
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');

  const marketClient = options.marketClient ?? new BybitMarketClient();
  const activeSymbolSet = options.activeSymbolSet ?? new ActiveSymbolSet();
  const universeService = new UniverseService(marketClient, activeSymbolSet, app.log, options.universeFilePath);
  const universeExclusionsService = new UniverseExclusionsService(options.universeExclusionsFilePath ?? path.resolve(process.cwd(), 'data/universe_exclusions.json'));
  const wsClients = options.wsClients ?? new Set<{ send: (payload: string) => unknown }>();
  const demoTradeClient = options.demoTradeClient ?? new DemoTradeClient();
  const rawMode = process.env.WS_SYMBOL_UPDATE_MODE;
  const symbolUpdateMode: SymbolUpdateMode = rawMode === 'batch' || rawMode === 'both' || rawMode === 'single' ? rawMode : 'single';
  const symbolUpdateBroadcaster = new SymbolUpdateBroadcaster(wsClients, 500, {
    mode: symbolUpdateMode,
    onFrameSent: () => {
      wsFramesSent += 1;
    }
  });
  const snapshotStore = new FileSnapshotStore(options.runtimeSnapshotFilePath ?? path.resolve(process.cwd(), 'data/runtime.json'));
  const journalPath = options.journalFilePath ?? path.resolve(process.cwd(), 'data/journal.ndjson');
  const journalService = new JournalService(journalPath);
  const profileService = new ProfileService(options.profileFilePath ?? path.resolve(process.cwd(), 'data/profiles.json'));

  const isDemoConfigured = (): boolean => {
    const apiKey = (process.env.DEMO_API_KEY ?? '').trim();
    const apiSecret = (process.env.DEMO_API_SECRET ?? '').trim();
    return apiKey.length > 0 && apiSecret.length > 0;
  };

  const getVersion = async (): Promise<string> => {
    try {
      const raw = await readFile(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
      return 'unknown';
    }
  };

  const getJournalSizeBytes = async (): Promise<number> => {
    try {
      const details = await stat(journalPath);
      return details.size;
    } catch {
      return 0;
    }
  };

  const appendOpsJournalEvent = async (event: JournalEntry['event']): Promise<void> => {
    const mode = botEngine.getState().config?.mode;
    if (!mode) {
      return;
    }

    await journalService.append({
      ts: Date.now(),
      mode,
      symbol: 'SYSTEM',
      event,
      side: null,
      data: {}
    });
  };

  const broadcast = (type: string, payload: unknown): void => {
    const message = JSON.stringify({ type, ts: Date.now(), payload });
    for (const client of wsClients) {
      client.send(message);
      wsFramesSent += 1;
    }
  };


  const getEffectiveUniverseEntries = async (entries: UniverseEntry[]): Promise<UniverseEntry[]> => {
    const exclusions = await universeExclusionsService.get();
    const excludedSet = new Set(exclusions.excluded);
    return entries.filter((entry) => !excludedSet.has(entry.symbol));
  };

  const buildBroadcastBotState = () => {
    const state = botEngine.getState();
    return {
      running: state.running,
      paused: state.paused,
      hasSnapshot: state.hasSnapshot,
      lastConfig: state.config,
      mode: state.config?.mode ?? null,
      direction: state.config?.direction ?? null,
      tf: state.config?.tf ?? null,
      queueDepth: state.queueDepth,
      activeOrders: state.activeOrders,
      openPositions: state.openPositions,
      startedAt: state.startedAt,
      uptimeMs: state.uptimeMs
    };
  };

  const broadcastBotState = (): void => {
    broadcast('state', buildBroadcastBotState());
  };

  const rotatePerfWindow = (nowMs: number): void => {
    if (nowMs - perfWindowStartedAtMs < perfWindowMs) {
      return;
    }

    perfWindowStartedAtMs = nowMs;
    tickHandlerTotalMs = 0;
    tickHandlerCount = 0;
    wsFramesSent = 0;
    evalRunCount = 0;
  };

  const getPerfMetrics = () => {
    const nowMs = Date.now();
    rotatePerfWindow(nowMs);
    const elapsedSec = Math.max((nowMs - perfWindowStartedAtMs) / 1000, 1);

    return {
      tickHandlersMsAvg: tickHandlerCount === 0 ? 0 : tickHandlerTotalMs / tickHandlerCount,
      wsFramesPerSec: wsFramesSent / elapsedSec,
      evalsPerSec: evalRunCount / elapsedSec
    };
  };

  const botEngine = new BotEngine({
    now: options.now,
    emitSignal: (payload) => {
      broadcast('signal:new', payload);
      const mode = botEngine.getState().config?.mode;
      if (mode) {
        void journalService.append({
          ts: Date.now(),
          mode,
          symbol: payload.symbol,
          event: 'SIGNAL',
          side: payload.side,
          data: {
            markPrice: payload.markPrice,
            oiValue: payload.oiValue,
            priceDeltaPct: payload.priceDeltaPct,
            oiDeltaPct: payload.oiDeltaPct,
            entryReason: payload.entryReason,
            ...(payload.bothCandidate ? { bothCandidate: payload.bothCandidate } : {})
          }
        });
      }
    },
    emitOrderUpdate: (payload) => {
      broadcast('order:update', payload);
      const mode = botEngine.getState().config?.mode;
      if (!mode) {
        return;
      }

      const eventByStatus: Record<typeof payload.status, JournalEntry['event']> = {
        PLACED: 'ORDER_PLACED',
        FILLED: 'ORDER_FILLED',
        CANCELLED: 'ORDER_CANCELLED',
        EXPIRED: 'ORDER_EXPIRED'
      };

      void journalService.append({
        ts: Date.now(),
        mode,
        symbol: payload.symbol,
        event: eventByStatus[payload.status],
        side: payload.order.side === 'Buy' ? 'LONG' : 'SHORT',
        data: {
          qty: payload.order.qty,
          limitPrice: payload.order.limitPrice,
          tpPrice: payload.order.tpPrice,
          slPrice: payload.order.slPrice,
          placedTs: payload.order.placedTs,
          expiresTs: payload.order.expiresTs,
          orderId: payload.order.orderId,
          orderLinkId: payload.order.orderLinkId
        }
      });
    },
    emitPositionUpdate: (payload) => {
      broadcast('position:update', payload);
      const mode = botEngine.getState().config?.mode;
      if (!mode) {
        return;
      }

      void journalService.append({
        ts: Date.now(),
        mode,
        symbol: payload.symbol,
        event: payload.status === 'OPEN' ? 'POSITION_OPENED' : 'POSITION_CLOSED',
        side: payload.position.side,
        data: {
          qty: payload.position.qty,
          entryPrice: payload.position.entryPrice,
          tpPrice: payload.position.tpPrice,
          slPrice: payload.position.slPrice,
          openedTs: payload.position.openedTs,
          exitPrice: payload.exitPrice,
          pnlUSDT: payload.pnlUSDT,
          closeReason: payload.closeReason,
          realizedGrossPnlUSDT: payload.realizedGrossPnlUSDT,
          feesUSDT: payload.feesUSDT,
          realizedNetPnlUSDT: payload.realizedNetPnlUSDT,
          entryFeeUSDT: payload.entryFeeUSDT,
          exitFeeUSDT: payload.exitFeeUSDT,
          entryFeeRate: payload.entryFeeRate,
          exitFeeRate: payload.exitFeeRate
        }
      });
    },
    emitQueueUpdate: (payload) => {
      broadcast('queue:update', payload);
    },
    demoTradeClient,
    snapshotStore,
    emitLog: (message) => emitLog(message)
  });

  const emitLog = (message: string): void => {
    broadcast('log', { message });
  };

  const processMarketStateUpdate = (symbol: string, state: { markPrice: number; openInterestValue: number; ts: number; lastPrice: number | null; bid: number | null; ask: number | null; spreadBps: number | null; lastTickTs: number }): void => {
    rotatePerfWindow(Date.now());
    const startedAt = Date.now();
    evalRunCount += 1;
    botEngine.onMarketUpdate(symbol, state);
    tickHandlerTotalMs += Math.max(0, Date.now() - startedAt);
    tickHandlerCount += 1;
    const symbolState = botEngine.getSymbolState(symbol);
    if (!symbolState) {
      return;
    }

    broadcastBotState();

    symbolUpdateBroadcaster.broadcast(
      symbol,
      state,
      symbolState.fsmState,
      symbolState.baseline,
      symbolState.pendingOrder,
      symbolState.position,
      botEngine.getOiCandleSnapshot(symbol),
      symbolState.lastNoEntryReasons,
      {
        entryReason: symbolState.entryReason,
        priceDeltaPct: symbolState.lastPriceDeltaPct,
        oiDeltaPct: symbolState.lastOiDeltaPct,
        signalCount24h: symbolState.lastSignalCount24h,
        signalCounterThreshold: botEngine.getState().config?.signalCounterThreshold,
        gates: symbolState.gates,
        bothCandidate: symbolState.lastBothCandidate
      }
    );
  };

  const marketHub = new MarketHub({
    tickerStream: options.tickerStream,
    onMarketStateUpdate: (symbol, state) => {
      processMarketStateUpdate(symbol, state);
    }
  });

  const replayService = new ReplayService({
    getUniverse: () => universeService.get(),
    getCurrentBotMode: () => botEngine.getState().config?.mode ?? null,
    isBotRunning: () => botEngine.getState().running,
    disableLiveMarket: async () => {
      if (marketHub.isRunning()) {
        await marketHub.stop();
      }
    },
    enableLiveMarket: async () => {
      if (!marketHub.isRunning()) {
        await marketHub.start();
      }
    },
    feedTick: (symbol, state) => {
      processMarketStateUpdate(symbol, state);
    },
    subscribeMarketTicks: (handler) => marketHub.onStateUpdate(handler),
    log: emitLog,
    replayDir: path.resolve(process.cwd(), 'data/replay')
  });
  marketHubByApp.set(app, marketHub);

  app.register(cors, { origin: true });
  app.register(websocket);

  app.get('/health', async () => {
    return { ok: true };
  });

  app.get('/api/profiles', async () => {
    const result = await profileService.list();
    return { ok: true, ...result };
  });

  app.get('/api/profiles/download', async (_request, reply) => {
    const exported = await profileService.export();
    reply.header('Content-Type', 'application/json');
    return reply.send(exported);
  });

  app.post('/api/profiles/upload', async (request, reply) => {
    try {
      await profileService.import(request.body);
      return { ok: true };
    } catch {
      return reply.code(400).send({ ok: false, error: 'INVALID_IMPORT' });
    }
  });

  app.get('/api/profiles/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const config = await profileService.get(name);
    if (!config) {
      return reply.code(404).send({ ok: false, error: 'NOT_FOUND' });
    }

    return { ok: true, name, config };
  });

  app.post('/api/profiles/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const config = normalizeBotConfig((request.body as Record<string, unknown>) ?? {});
    if (!config) {
      return reply.code(400).send({ ok: false, error: 'INVALID_BOT_CONFIG' });
    }

    await profileService.set(name, config);
    return { ok: true };
  });

  app.post('/api/profiles/:name/active', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      await profileService.setActive(name);
      return { ok: true };
    } catch {
      return reply.code(404).send({ ok: false, error: 'NOT_FOUND' });
    }
  });

  app.delete('/api/profiles/:name', async (request, reply) => {
    const name = (request.params as { name: string }).name;
    try {
      await profileService.delete(name);
      return { ok: true };
    } catch (error) {
      if ((error as Error).message === 'DEFAULT_PROFILE_LOCKED') {
        return reply.code(400).send({ ok: false, error: 'DEFAULT_PROFILE_LOCKED' });
      }

      return reply.code(404).send({ ok: false, error: 'NOT_FOUND' });
    }
  });

  app.post('/api/bot/start', async (request, reply) => {
    const universe = await universeService.get();
    if (!universe?.ready || universe.symbols.length === 0) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    if (!marketHub.isRunning()) {
      return reply.code(400).send({ ok: false, error: 'MARKET_HUB_NOT_RUNNING' });
    }

    const requestBody = request.body as Record<string, unknown> | null | undefined;
    const shouldUseActiveProfile = requestBody == null || requestBody.mode === undefined;
    const config = shouldUseActiveProfile
      ? await profileService.get((await profileService.list()).activeProfile)
      : normalizeBotConfig(requestBody);
    if (!config) {
      return reply.code(400).send({ ok: false, error: 'INVALID_BOT_CONFIG' });
    }

    if (config.mode === 'demo' && !isDemoConfigured()) {
      return reply
        .code(400)
        .send({ ok: false, error: { code: 'DEMO_NOT_CONFIGURED', message: 'Demo mode requires DEMO_API_KEY and DEMO_API_SECRET.' } });
    }

    const effectiveEntries = await getEffectiveUniverseEntries(universe.symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    botEngine.start(config);
    broadcastBotState();

    return { ok: true, ...botEngine.getState() };
  });

  app.post('/api/bot/stop', async () => {
    botEngine.stop();
    broadcastBotState();
    return { ok: true, ...botEngine.getState() };
  });

  app.post('/api/bot/pause', async () => {
    botEngine.pause();
    broadcastBotState();
    await appendOpsJournalEvent('BOT_PAUSE');
    return { ok: true, ...botEngine.getState() };
  });

  app.post('/api/bot/resume', async (_request, reply) => {
    const state = botEngine.getState();
    if (!state.hasSnapshot) {
      return reply.code(400).send({ ok: false, error: 'NO_SNAPSHOT' });
    }

    const universe = await universeService.get();
    const effectiveEntries = universe?.ready ? await getEffectiveUniverseEntries(universe.symbols) : [];
    const canRun = effectiveEntries.length > 0 && marketHub.isRunning();
    if (!canRun) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    botEngine.resume(true);
    broadcastBotState();
    await appendOpsJournalEvent('BOT_RESUME');
    return { ok: true, ...botEngine.getState() };
  });

  app.get('/api/bot/state', async () => {
    return buildBroadcastBotState();
  });


  app.post('/api/bot/kill', async () => {
    const cancelled = await botEngine.killSwitch((symbol) => marketHub.getState(symbol));
    broadcastBotState();
    await appendOpsJournalEvent('BOT_KILL');
    return { ok: true, cancelled };
  });

  app.get('/api/bot/guardrails', async () => {
    return { ok: true, guardrails: botEngine.getGuardrails() };
  });

  app.get('/api/bot/stats', async () => {
    return { ok: true, stats: botEngine.getStats() };
  });

  app.post('/api/bot/stats/reset', async () => {
    botEngine.resetStats();
    return { ok: true };
  });

  app.post('/api/reset/all', async (_request, reply) => {
    const botState = botEngine.getState();
    if (botState.running) {
      return reply.code(400).send({ ok: false, error: 'BOT_RUNNING' });
    }

    await replayService.stopRecording();
    await replayService.stopReplay();

    botEngine.stop();
    botEngine.resetStats();
    botEngine.resetRuntimeStateForAllSymbols();

    await appendOpsJournalEvent('SYSTEM_RESET_ALL');
    await journalService.clear();
    await universeExclusionsService.clear();
    await universeService.clear();
    await marketHub.setUniverseSymbols([]);
    botEngine.setUniverseSymbols([]);
    symbolUpdateBroadcaster.setTrackedSymbols([]);
    symbolUpdateBroadcaster.reset();
    rotatePerfWindow(Date.now());
    botEngine.clearPersistedRuntime();

    broadcastBotState();

    return {
      ok: true,
      cleared: {
        stats: true,
        journal: true,
        runtime: true,
        exclusions: true,
        universe: true,
        replay: true
      }
    };
  });

  app.get('/api/doctor', async () => {
    const universe = await universeService.get();
    const replay = replayService.getState();
    const botState = botEngine.getState();
    const perfMetrics = getPerfMetrics();
    const journalSizeBytes = await getJournalSizeBytes();

    return {
      ok: true,
      serverTime: Date.now(),
      uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
      version: await getVersion(),
      universe: {
        ready: !!universe?.ready,
        symbols: universe?.symbols.length ?? 0
      },
      market: {
        running: marketHub.isRunning(),
        subscribed: marketHub.getSubscribedCount(),
        updatesPerSec: Number(marketHub.getUpdatesPerSecond().toFixed(2)),
        tickHandlersMsAvg: Number(perfMetrics.tickHandlersMsAvg.toFixed(2)),
        wsClients: wsClients.size,
        wsFramesPerSec: Number(perfMetrics.wsFramesPerSec.toFixed(2))
      },
      bot: {
        running: botState.running,
        paused: botState.paused,
        mode: botState.config?.mode ?? null,
        tf: botState.config?.tf ?? null,
        direction: botState.config?.direction ?? null,
        evalsPerSec: Number(perfMetrics.evalsPerSec.toFixed(2))
      },
      replay: {
        recording: replay.recording,
        replaying: replay.replaying,
        fileName: replay.fileName
      },
      journal: {
        enabled: true,
        path: journalPath,
        sizeBytes: journalSizeBytes
      },
      demo: {
        configured: isDemoConfigured()
      }
    };
  });

  app.post('/api/replay/record/start', async (request, reply) => {
    const body = request.body as { topN?: unknown; fileName?: unknown };
    const topN = body?.topN === undefined ? 20 : body.topN;
    if (typeof topN !== 'number' || !Number.isFinite(topN) || topN < 1) {
      return reply.code(400).send({ ok: false, error: 'INVALID_TOP_N' });
    }

    const fileName = typeof body?.fileName === 'string' && body.fileName.length > 0 ? body.fileName : '';
    if (!fileName.endsWith('.ndjson')) {
      return reply.code(400).send({ ok: false, error: 'INVALID_FILE_NAME' });
    }

    try {
      const result = await replayService.startRecording(fileName, topN);
      return { ok: true, path: `backend/data/replay/${path.basename(result.path)}`, startedAt: result.startedAt };
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'UNIVERSE_NOT_READY') {
        return reply.code(400).send({ ok: false, error: code });
      }

      return reply.code(400).send({ ok: false, error: 'REPLAY_BUSY' });
    }
  });

  app.post('/api/replay/record/stop', async () => {
    const result = await replayService.stopRecording();
    return { ok: true, stoppedAt: result.stoppedAt, recordsWritten: result.recordsWritten };
  });

  app.post('/api/replay/start', async (request, reply) => {
    const body = request.body as { fileName?: unknown; speed?: unknown };
    if (typeof body?.fileName !== 'string' || body.fileName.length === 0) {
      return reply.code(400).send({ ok: false, error: 'INVALID_FILE_NAME' });
    }

    if (body.speed !== '1x' && body.speed !== '5x' && body.speed !== '20x' && body.speed !== 'fast') {
      return reply.code(400).send({ ok: false, error: 'INVALID_SPEED' });
    }

    try {
      const result = await replayService.startReplay(body.fileName, body.speed as ReplaySpeed);
      return { ok: true, startedAt: result.startedAt };
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'REPLAY_REQUIRES_PAPER_MODE') {
        return reply.code(400).send({ ok: false, error: code });
      }

      return reply.code(400).send({ ok: false, error: 'REPLAY_BUSY' });
    }
  });

  app.post('/api/replay/stop', async () => {
    const result = await replayService.stopReplay();
    return { ok: true, stoppedAt: result.stoppedAt };
  });

  app.get('/api/replay/state', async () => {
    return replayService.getState();
  });

  app.get('/api/replay/files', async () => {
    return { ok: true, files: await replayService.listFiles() };
  });

  app.get('/api/journal/tail', async (request, reply) => {
    const query = request.query as { limit?: string | number };
    const parsedLimit = Number(query.limit ?? 200);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      return reply.code(400).send({ ok: false, error: 'INVALID_LIMIT' });
    }

    const limit = Math.min(5000, Math.floor(parsedLimit));
    const entries = await journalService.tail(limit);
    return { ok: true, entries };
  });

  app.post('/api/journal/clear', async () => {
    await journalService.clear();
    return { ok: true };
  });

  app.get('/api/journal/download', async (request, reply) => {
    const query = request.query as { format?: string };
    const format = query.format ?? 'ndjson';
    if (format !== 'ndjson' && format !== 'json' && format !== 'csv') {
      return reply.code(400).send({ ok: false, error: 'INVALID_FORMAT' });
    }

    if (format === 'ndjson') {
      const raw = await journalService.readRaw();
      return reply.type('application/x-ndjson').send(raw);
    }

    const entries = await journalService.tail(Number.MAX_SAFE_INTEGER);
    if (format === 'json') {
      return reply.type('application/json').send(entries);
    }

    const header = 'ts,mode,symbol,event,side,qty,price,exitPrice,pnlUSDT,detailsJson';
    const rows = entries.map((entry) => {
      const qty = typeof entry.data.qty === 'number' ? entry.data.qty : '';
      const price =
        typeof entry.data.limitPrice === 'number'
          ? entry.data.limitPrice
          : typeof entry.data.entryPrice === 'number'
            ? entry.data.entryPrice
            : typeof entry.data.markPrice === 'number'
              ? entry.data.markPrice
              : '';
      const exitPrice = typeof entry.data.exitPrice === 'number' ? entry.data.exitPrice : '';
      const pnlUSDT = typeof entry.data.pnlUSDT === 'number' ? entry.data.pnlUSDT : '';
      const detailsJson = JSON.stringify(entry.data).replaceAll('"', '""');
      return `${entry.ts},${entry.mode},${entry.symbol},${entry.event},${entry.side ?? ''},${qty},${price},${exitPrice},${pnlUSDT},"${detailsJson}"`;
    });

    return reply.type('text/csv').send([header, ...rows].join('\n'));
  });

  app.get('/api/export/pack', async (request, reply) => {
    const zip = new JSZip();
    const missingFiles: string[] = [];

    const readOrEmpty = async (filePath: string): Promise<string> => {
      try {
        return await readFile(filePath, 'utf-8');
      } catch {
        missingFiles.push(path.basename(filePath));
        return '';
      }
    };

    const universePath = options.universeFilePath ?? path.resolve(process.cwd(), 'data/universe.json');
    const runtimePath = options.runtimeSnapshotFilePath ?? path.resolve(process.cwd(), 'data/runtime.json');
    const profilesPath = options.profileFilePath ?? path.resolve(process.cwd(), 'data/profiles.json');

    zip.file('universe.json', await readOrEmpty(universePath));
    zip.file('profiles.json', await readOrEmpty(profilesPath));
    zip.file('runtime.json', await readOrEmpty(runtimePath));
    zip.file('journal.ndjson', await readOrEmpty(journalPath));

    zip.file(
      'meta.json',
      JSON.stringify(
        {
          ts: Date.now(),
          version: await getVersion(),
          missing: missingFiles
        },
        null,
        2
      )
    );

    const payload = await zip.generateAsync({ type: 'nodebuffer' });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename=export-pack-${Date.now()}.zip`);
    return reply.send(payload);
  });

  app.post('/api/orders/cancel', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    if (typeof body?.symbol !== 'string' || body.symbol.length === 0) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const marketState = marketHub.getState(body.symbol);
    if (!marketState) {
      return { ok: true };
    }

    await botEngine.cancelPendingOrder(body.symbol, marketState);
    return { ok: true };
  });

  app.post('/api/universe/create', async (request, reply) => {
    const body = request.body as { minVolPct?: unknown; minTurnover?: unknown };

    if (typeof body?.minVolPct !== 'number' || !Number.isFinite(body.minVolPct)) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_VOL_PCT' });
    }

    if (body?.minTurnover !== undefined && (typeof body.minTurnover !== 'number' || !Number.isFinite(body.minTurnover))) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_TURNOVER' });
    }

    const result = await universeService.create(body.minVolPct, body.minTurnover);
    await universeExclusionsService.clear();
    const effectiveEntries = await getEffectiveUniverseEntries(result.state.symbols);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    const response = {
      ok: true,
      createdAt: result.state.createdAt,
      filters: result.state.filters,
      metricDefinition: result.state.metricDefinition,
      totalFetched: result.totalFetched,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive,
      contractFilter: result.state.contractFilter,
      filteredOut: result.state.filteredOut
    };

    broadcast('universe:created', {
      filters: response.filters,
      passed: response.passed,
      forcedActive: response.forcedActive
    });

    return response;
  });

  app.post('/api/universe/refresh', async (request, reply) => {
    const body = request.body as { minVolPct?: unknown; minTurnover?: unknown } | undefined;

    if (body?.minVolPct !== undefined && (typeof body.minVolPct !== 'number' || !Number.isFinite(body.minVolPct))) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_VOL_PCT' });
    }

    if (body?.minTurnover !== undefined && (typeof body.minTurnover !== 'number' || !Number.isFinite(body.minTurnover))) {
      return reply.code(400).send({ ok: false, error: 'INVALID_MIN_TURNOVER' });
    }

    const result = await universeService.refresh(body?.minVolPct, body?.minTurnover);
    if (!result) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    const effectiveEntries = await getEffectiveUniverseEntries(result.state.symbols);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);

    const response = {
      ok: true,
      refreshedAt: result.state.createdAt,
      filters: result.state.filters,
      metricDefinition: result.state.metricDefinition,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive,
      contractFilter: result.state.contractFilter,
      filteredOut: result.state.filteredOut
    };

    broadcast('universe:refreshed', {
      filters: response.filters,
      passed: response.passed,
      forcedActive: response.forcedActive
    });

    return response;
  });


  app.get('/api/universe/exclusions', async () => {
    const state = await universeExclusionsService.get();
    return { ok: true, excluded: state.excluded };
  });

  app.post('/api/universe/exclusions/add', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const botState = botEngine.getState();
    if (botState.running) {
      return reply.code(400).send({ ok: false, error: 'BOT_RUNNING' });
    }

    const universe = await universeService.get();
    if (!universe?.ready) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    if (!universe.symbols.some((entry) => entry.symbol === symbol)) {
      return reply.code(400).send({ ok: false, error: 'SYMBOL_NOT_IN_UNIVERSE' });
    }

    const state = await universeExclusionsService.add(symbol);
    const effectiveEntries = await getEffectiveUniverseEntries(universe.symbols);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, excluded: state.excluded };
  });

  app.post('/api/universe/exclusions/remove', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const botState = botEngine.getState();
    if (botState.running) {
      return reply.code(400).send({ ok: false, error: 'BOT_RUNNING' });
    }

    const universe = await universeService.get();
    if (!universe?.ready) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    const state = await universeExclusionsService.remove(symbol);
    const effectiveEntries = await getEffectiveUniverseEntries(universe.symbols);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, excluded: state.excluded };
  });

  app.post('/api/universe/exclusions/clear', async (_request, reply) => {
    const botState = botEngine.getState();
    if (botState.running) {
      return reply.code(400).send({ ok: false, error: 'BOT_RUNNING' });
    }

    const universe = await universeService.get();
    if (!universe?.ready) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    const state = await universeExclusionsService.clear();
    const symbols = universe.symbols.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(universe.symbols);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, excluded: state.excluded };
  });

  app.get('/api/universe', async () => {
    const state = await universeService.get();
    if (!state) {
      return { ok: false, ready: false };
    }

    const exclusions = await universeExclusionsService.get();
    return {
      ok: true,
      ...state,
      excluded: exclusions.excluded
    };
  });

  app.get('/api/universe/download', async (_request, reply) => {
    const state = await universeService.get();
    if (!state?.ready) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    return reply.type('application/json').send(state);
  });

  app.post('/api/universe/clear', async () => {
    await universeService.clear();
    await universeExclusionsService.clear();
    await marketHub.setUniverseSymbols([]);
    botEngine.setUniverseSymbols([]);
    botEngine.clearSnapshotState();
    symbolUpdateBroadcaster.setTrackedSymbols([]);
    symbolUpdateBroadcaster.reset();
    rotatePerfWindow(Date.now());
    return { ok: true };
  });

  app.register(async function wsRoutes(fastify) {
    fastify.get('/ws', { websocket: true }, (socket) => {
      wsClients.add(socket as { send: (payload: string) => unknown });
      socket.on('close', () => {
        wsClients.delete(socket as { send: (payload: string) => unknown });
      });

      socket.send(
        JSON.stringify({
          type: 'state',
          ts: Date.now(),
          payload: buildBroadcastBotState()
        })
      );
      wsFramesSent += 1;
    });
  });

  const demoPoller = setInterval(() => {
    void botEngine.pollDemoOrders(marketHub.getAllStates());
  }, 1500);

  app.addHook('onReady', async () => {
    const snapshot = snapshotStore.load();
    if (snapshot) {
      const normalizedSnapshotConfig =
        snapshot.config && typeof snapshot.config === 'object' ? normalizeBotConfig(snapshot.config as Record<string, unknown>) : null;
      botEngine.restoreFromSnapshot({ ...snapshot, config: normalizedSnapshotConfig });
    }

    const universe = await universeService.get();
    const universeEntries = universe?.ready ? await getEffectiveUniverseEntries(universe.symbols) : [];
    const universeSymbols = universeEntries.map((entry) => entry.symbol);
    const runtimeSymbols = botEngine.getRuntimeSymbols();
    const symbols = Array.from(new Set([...universeSymbols, ...runtimeSymbols]));

    await marketHub.start();
    await marketHub.setUniverseSymbols(symbols);
    if (universe?.ready) {
      botEngine.setUniverseEntries(universeEntries);
      const missingRuntimeSymbols = runtimeSymbols.filter((symbol) => !universeSymbols.includes(symbol));
      if (missingRuntimeSymbols.length > 0) {
        botEngine.setUniverseSymbols(Array.from(new Set([...universeSymbols, ...missingRuntimeSymbols])));
      }
    } else {
      botEngine.setUniverseSymbols(symbols);
    }
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
  });

  app.addHook('onClose', async () => {
    clearInterval(demoPoller);
    await replayService.stopRecording();
    await replayService.stopReplay();
    await marketHub.stop();
  });

  return app;
}

import { execSync } from 'node:child_process';
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
import { RunRecorderService } from './services/runRecorderService.js';
import { AutoTuneService } from './services/autoTuneService.js';
import { AUTO_TUNE_BOUNDS, planAutoTuneChange } from './services/autoTunePlanner.js';
import { createDeterministicRng, mixSeed32 } from './utils/deterministicRng.js';
import { DoctorService } from './services/doctorService.js';
import { RunHistoryService } from './services/runHistoryService.js';
import { RunEventsService } from './services/runEventsService.js';
import { resolveStoragePaths } from './services/storagePaths.js';
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
const runtimeHandlesByApp = new WeakMap<
  FastifyInstance,
  { botEngine: BotEngine; runRecorder: RunRecorderService; journalService: JournalService }
>();

export function getMarketHub(app: FastifyInstance): MarketHub {
  const marketHub = marketHubByApp.get(app);
  if (!marketHub) {
    throw new Error('MarketHub is not registered for this app instance');
  }

  return marketHub;
}

export function getRuntimeHandles(app: FastifyInstance): { botEngine: BotEngine; runRecorder: RunRecorderService; journalService: JournalService } {
  const handles = runtimeHandlesByApp.get(app);
  if (!handles) {
    throw new Error('Runtime handles are not registered for this app instance');
  }

  return handles;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  const perfWindowMs = 5000;
  let perfWindowStartedAtMs = Date.now();
  let tickHandlerTotalMs = 0;
  let tickHandlerCount = 0;
  let wsFramesSent = 0;
  let evalRunCount = 0;
  let killInProgress = false;
  let killCompletedAt: number | null = null;
  let killWarning: string | null = null;
  let lastJournalTs = 0;
  let currentRunProfileNameUsed: string | null = null;
  let currentRunId: string | null = null;
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');

  const marketClient = options.marketClient ?? new BybitMarketClient();
  const storagePaths = resolveStoragePaths({
    universePath: options.universeFilePath,
    runtimePath: options.runtimeSnapshotFilePath,
    profilesPath: options.profileFilePath,
    journalPath: options.journalFilePath
  });
  const activeSymbolSet = options.activeSymbolSet ?? new ActiveSymbolSet();
  const universeService = new UniverseService(marketClient, activeSymbolSet, app.log, storagePaths.universePath);
  const universeExclusionsService = new UniverseExclusionsService(options.universeExclusionsFilePath ?? path.resolve(process.cwd(), 'data/universe-exclusions.json'));
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
  const snapshotStore = new FileSnapshotStore(storagePaths.runtimePath);
  const journalPath = storagePaths.journalPath;
  const journalService = new JournalService(journalPath);
  const profileService = new ProfileService(storagePaths.profilesPath);
  const runRecorder = new RunRecorderService();
  const runHistoryService = new RunHistoryService();
  const runEventsService = new RunEventsService();
  const dataDirPath = path.resolve(process.cwd(), 'data');
  const autoTuneService = new AutoTuneService();
  void autoTuneService.init();

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


  const getCommitHash = (): string | null => {
    try {
      return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  };

  const appendOpsJournalEvent = async (event: JournalEntry['event'], data: Record<string, unknown> = {}): Promise<void> => {
    const mode = botEngine.getState().config?.mode ?? 'paper';

    try {
      const ts = Date.now();
      await journalService.append({
        ts,
        mode,
        symbol: 'SYSTEM',
        event,
        side: null,
        data
      });
      lastJournalTs = ts;
    } catch (error) {
      app.log.warn({ err: error, event }, 'Failed to append ops journal event');
    }

    await runRecorder.appendEvent({ ts: Date.now(), type: 'SYSTEM', event, data });
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
    const excludedSet = new Set(exclusions.symbols);
    return entries.filter((entry) => !excludedSet.has(entry.symbol));
  };

  const buildBroadcastBotState = () => {
    const state = botEngine.getState();
    const stats = botEngine.getStats();
    const perf = getPerfMetrics();
    const now = Date.now();
    const symbols = botEngine.getRuntimeSymbols();
    const openOrders = symbols
      .map((symbol) => {
        const runtime = botEngine.getSymbolState(symbol);
        if (!runtime?.pendingOrder) {
          return null;
        }

        return {
          symbol,
          side: runtime.pendingOrder.side,
          qty: runtime.pendingOrder.qty,
          limitPrice: runtime.pendingOrder.limitPrice,
          status: runtime.fsmState,
          orderId: runtime.pendingOrder.orderId ?? null,
          orderLinkId: runtime.pendingOrder.orderLinkId ?? null
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const positions = symbols
      .map((symbol) => {
        const runtime = botEngine.getSymbolState(symbol);
        if (!runtime?.position) {
          return null;
        }

        return {
          symbol,
          side: runtime.position.side,
          size: runtime.position.qty,
          avgPrice: runtime.position.entryPrice,
          unrealizedPnl: runtime.position.lastPnlUSDT ?? 0
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const activeSymbolDiagnostics = symbols
      .map((symbol) => {
        const runtime = botEngine.getSymbolState(symbol);
        if (!runtime) {
          return null;
        }
        const market = marketHub.getState(symbol);
        const nextFunding = runtime.nextFundingTimeMs ?? market?.nextFundingTimeMs ?? null;
        const timeToFundingMs = nextFunding ? nextFunding - now : null;
        return {
          symbol,
          signalCount24h: runtime.lastSignalCount24h ?? 0,
          minTriggerCount: state.config?.minTriggerCount ?? state.config?.signalCounterMin ?? 2,
          maxTriggerCount: state.config?.maxTriggerCount ?? state.config?.signalCounterMax ?? 3,
          lastSignalAt: runtime.lastSignalAtMs ?? (runtime.signalEvents24h?.length ? runtime.signalEvents24h[runtime.signalEvents24h.length - 1] : undefined),
          fundingRate: runtime.fundingRate ?? market?.fundingRate ?? null,
          nextFundingTimeMs: nextFunding,
          timeToFundingMs,
          tradingAllowed: runtime.tradingAllowed ?? 'MISSING',
          priceDeltaPct: runtime.lastPriceDeltaPct ?? null,
          oiDeltaPct: runtime.lastOiDeltaPct ?? null
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    return {
      running: state.running,
      paused: state.paused,
      pauseReason: stats.guardrailPauseReason,
      hasSnapshot: state.hasSnapshot,
      lastConfig: state.config,
      mode: state.config?.mode ?? null,
      direction: state.config?.direction ?? null,
      tf: state.config?.tf ?? null,
      queueDepth: Number.isFinite(state.queueDepth) ? state.queueDepth : 0,
      activeOrders: Number.isFinite(state.activeOrders) ? state.activeOrders : 0,
      openPositions: Number.isFinite(state.openPositions) ? state.openPositions : 0,
      symbolUpdatesPerSec: Number.isFinite(perf.evalsPerSec) ? Number(perf.evalsPerSec.toFixed(2)) : 0,
      journalAgeMs: lastJournalTs > 0 ? Math.max(0, now - lastJournalTs) : 0,
      openOrders,
      positions,
      activeSymbolDiagnostics,
      startedAt: state.startedAt,
      uptimeMs: state.uptimeMs,
      killInProgress,
      killCompletedAt,
      killWarning
    };
  };

  const buildApiBotState = async () => {
    const state = botEngine.getState();
    const perf = getPerfMetrics();
    const now = Date.now();
    const symbols = botEngine.getRuntimeSymbols();
    const universe = await universeService.get();
    const exclusions = await universeExclusionsService.get();
    const phase: 'STOPPED' | 'RUNNING' | 'PAUSED' = state.paused ? 'PAUSED' : state.running ? 'RUNNING' : 'STOPPED';

    const normalizedConfig = state.config ? normalizeBotConfig(state.config) : null;
    const toFinite = (value: unknown): number => {
      const asNumber = typeof value === 'number' ? value : Number.NaN;
      return Number.isFinite(asNumber) ? asNumber : 0;
    };

    return {
      bot: {
        phase,
        running: state.running,
        startedAt: state.startedAt ?? null,
        stoppedAt: !state.running && !state.paused ? now : null,
        lastError: null
      },
      config: {
        tfMinutes: toFinite(normalizedConfig?.tf),
        priceUpThrPct: toFinite(normalizedConfig?.priceUpThrPct),
        oiUpThrPct: toFinite(normalizedConfig?.oiUpThrPct),
        minTriggerCount: toFinite(normalizedConfig?.signalCounterMin),
        maxTriggerCount: toFinite(normalizedConfig?.signalCounterMax)
      },
      universe: {
        ready: Boolean(universe?.ready),
        symbolsCount: Array.isArray(universe?.symbols) ? universe.symbols.length : 0,
        excludedCount: exclusions.symbols.length
      },
      activity: {
        queueDepth: Number.isFinite(state.queueDepth) ? state.queueDepth : 0,
        activeOrders: Number.isFinite(state.activeOrders) ? state.activeOrders : 0,
        openPositions: Number.isFinite(state.openPositions) ? state.openPositions : 0,
        symbolUpdatesPerSec: Number.isFinite(perf.evalsPerSec) ? Number(perf.evalsPerSec.toFixed(2)) : 0,
        journalAgeMs: lastJournalTs > 0 ? Math.max(0, now - lastJournalTs) : 0
      },
      symbols: symbols.map((symbol) => {
        const runtime = botEngine.getSymbolState(symbol);
        const market = marketHub.getState(symbol);
        const nextFundingTimeMs = runtime?.nextFundingTimeMs ?? market?.nextFundingTimeMs ?? null;
        const timeToFundingMs = nextFundingTimeMs === null ? null : Math.max(0, nextFundingTimeMs - now);

        return {
          symbol,
          markPrice: typeof market?.markPrice === 'number' && Number.isFinite(market.markPrice) ? market.markPrice : 0,
          openInterestValue:
            typeof market?.openInterestValue === 'number' && Number.isFinite(market.openInterestValue) ? market.openInterestValue : 0,
          priceDeltaPct: typeof runtime?.lastPriceDeltaPct === 'number' && Number.isFinite(runtime.lastPriceDeltaPct) ? runtime.lastPriceDeltaPct : 0,
          oiDeltaPct: typeof runtime?.lastOiDeltaPct === 'number' && Number.isFinite(runtime.lastOiDeltaPct) ? runtime.lastOiDeltaPct : 0,
          fundingRate: runtime?.fundingRate ?? market?.fundingRate ?? null,
          nextFundingTimeMs,
          timeToFundingMs,
          tradability: runtime?.tradingAllowed ?? 'MISSING',
          blackoutReason: runtime?.blackoutReason ?? null,
          signalCount24h: runtime?.lastSignalCount24h ?? 0,
          lastSignalAtMs: runtime?.lastSignalAtMs ?? null
        };
      }),
      // legacy fields kept for additive-safe migration
      ...buildBroadcastBotState()
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

  const doctorService = new DoctorService({
    getBotState: () => {
      const state = buildBroadcastBotState();
      return {
        running: state.running,
        paused: state.paused,
        activeOrders: state.activeOrders,
        openPositions: state.openPositions,
        mode: state.mode,
        tf: state.tf,
        direction: state.direction
      };
    },
    getMarketStates: () => marketHub.getAllStates(),
    getTrackedSymbols: () => botEngine.getRuntimeSymbols(),
    getTickerStreamStatus: () => marketHub.getTickerStreamStatus(),
    getUniverseState: () => universeService.get(),
    getVersion: async () => ({
      commit: getCommitHash() ?? undefined,
      node: process.version
    })
  });

  const botEngine = new BotEngine({
    now: options.now,
    emitSignal: (payload) => {
      broadcast('signal:new', payload);
      const mode = botEngine.getState().config?.mode;
      if (mode) {
        void runRecorder.appendEvent({ ts: Date.now(), type: 'signal:new', payload });
        const ts = Date.now();
        lastJournalTs = ts;
        void journalService.append({
          ts,
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

      void runRecorder.appendEvent({ ts: Date.now(), type: 'order:update', payload });

      const eventByStatus: Record<typeof payload.status, JournalEntry['event']> = {
        PLACED: 'ORDER_PLACED',
        FILLED: 'ORDER_FILLED',
        CANCELLED: 'ORDER_CANCELLED',
        EXPIRED: 'ORDER_EXPIRED'
      };

      const ts = Date.now();
      lastJournalTs = ts;
      void journalService.append({
        ts,
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

      void runRecorder.appendEvent({ ts: Date.now(), type: 'position:update', payload });
      const ts = Date.now();
      lastJournalTs = ts;
      void journalService.append({
        ts,
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
          exitFeeRate: payload.exitFeeRate,
          entry: payload.entry,
          exit: payload.exit,
          impact: payload.impact
        }
      });

      if (payload.status === 'CLOSED') {
        void autoTuneService.noteCloseSeen();
        const currentConfig = botEngine.getState().config;
        const tuneState = autoTuneService.getState();
        if (currentConfig && tuneState.enabled) {
          void (async () => {
            const recentRuns = await runHistoryService.summarizeRecent(20);
            const rngSeed = mixSeed32(
              tuneState.closesSeen,
              Number.parseInt((currentRunId ?? '').replace(/\D/g, ''), 10) || 0,
              botEngine.getState().startedAt ?? 0,
              Object.keys(AUTO_TUNE_BOUNDS).length
            );
            const plan = planAutoTuneChange({
              currentConfig,
              autoTuneScope: tuneState.scope,
              recentRuns,
              currentBotStats: botEngine.getStats(),
              nowMs: Date.now(),
              plannerMode: currentConfig.autoTunePlannerMode ?? 'DETERMINISTIC',
              rng: createDeterministicRng(rngSeed)
            });

            if (!plan) {
              return;
            }

            if (plan.kind === 'CONFIG_PATCH') {
              const updated = botEngine.applyConfigPatch(plan.patch);
              if (!updated) return;

              await autoTuneService.noteApplied({
                parameter: plan.parameter,
                before: plan.before,
                after: plan.after,
                reason: plan.reason,
                bounds: { min: AUTO_TUNE_BOUNDS[plan.parameter].min, max: AUTO_TUNE_BOUNDS[plan.parameter].max }
              });

              await appendOpsJournalEvent('AUTO_TUNE_APPLIED', {
                kind: 'AUTO_TUNE_APPLIED',
                changeKind: 'CONFIG_PATCH',
                parameter: plan.parameter,
                before: plan.before,
                after: plan.after,
                reason: plan.reason
              });

              if (currentRunProfileNameUsed) {
                await profileService.set(currentRunProfileNameUsed, updated);
              }
              return;
            }

            const exclusions = await universeExclusionsService.get();
            const beforeCount = exclusions.symbols.length;
            await universeExclusionsService.add(plan.symbol, 'autotune');
            const afterCount = (await universeExclusionsService.get()).symbols.length;

            await autoTuneService.noteApplied({
              parameter: 'universeExclusionsCount',
              before: beforeCount,
              after: afterCount,
              reason: `${plan.reason}; excluded=${plan.symbol}`,
              bounds: { min: 0, max: Number.MAX_SAFE_INTEGER }
            });

            await appendOpsJournalEvent('AUTO_TUNE_APPLIED', {
              kind: 'AUTO_TUNE_APPLIED',
              changeKind: 'UNIVERSE_EXCLUDE',
              symbol: plan.symbol,
              beforeCount,
              afterCount,
              reason: plan.reason
            });
          })();
        }
      }
    },
    emitQueueUpdate: (payload) => {
      broadcast('queue:update', payload);
    },
    demoTradeClient,
    snapshotStore,
    emitLog: (message) => emitLog(message),
    onGuardrailPaused: (payload) => {
      void appendOpsJournalEvent('GUARDRAIL_PAUSED', {
        reason: payload.reason,
        stats: payload.stats
      });
    }
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

    const currentConfig = botEngine.getState().config;

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
        signalCounterThreshold: currentConfig?.signalCounterThreshold,
        signalCounterMin: currentConfig?.signalCounterMin,
        signalCounterMax: currentConfig?.signalCounterMax,
        signalCounterEligible: currentConfig ? symbolState.lastSignalCount24h >= currentConfig.signalCounterMin && symbolState.lastSignalCount24h <= currentConfig.signalCounterMax : undefined,
        signalConfirmed: currentConfig ? symbolState.lastSignalCount24h >= currentConfig.signalCounterThreshold : undefined,
        lastSignalAt: symbolState.signalEvents24h.length > 0 ? symbolState.signalEvents24h[symbolState.signalEvents24h.length - 1] : undefined,
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
    const profilesList = await profileService.list();
    const config = shouldUseActiveProfile
      ? await profileService.get(profilesList.activeProfile)
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
    currentRunProfileNameUsed = shouldUseActiveProfile ? profilesList.activeProfile : null;
    await autoTuneService.setEnabledScope(config.autoTuneEnabled, config.autoTuneScope);
    const run = await runRecorder.startRun({
      startTime: Date.now(),
      configSnapshot: config,
      universeSummary: { total: universe.symbols.length, effective: effectiveEntries.length },
      commitHash: getCommitHash()
    });
    currentRunId = run?.runId ?? null;
    await runRecorder.appendEvent({ ts: Date.now(), type: 'SYSTEM', event: 'BOT_START' });
    botEngine.start(config);
    broadcastBotState();

    return { ok: true, ...botEngine.getState() };
  });

  app.post('/api/bot/stop', async () => {
    botEngine.stop();
    currentRunProfileNameUsed = null;
    currentRunId = null;
    await runRecorder.writeStats(botEngine.getStats() as unknown as Record<string, unknown>);
    await runRecorder.appendEvent({ ts: Date.now(), type: 'SYSTEM', event: 'BOT_STOP' });
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

    const resumedState = botEngine.getState();
    currentRunProfileNameUsed = null;
    const run = await runRecorder.startRun({
      startTime: Date.now(),
      configSnapshot: resumedState.config,
      universeSummary: { total: universe?.symbols.length ?? 0, effective: effectiveEntries.length },
      commitHash: getCommitHash(),
      resumedFromSnapshot: true
    });
    currentRunId = run?.runId ?? null;
    botEngine.resume(true);
    await runRecorder.appendEvent({ ts: Date.now(), type: 'SYSTEM', event: 'BOT_RESUME' });
    broadcastBotState();
    await appendOpsJournalEvent('BOT_RESUME');
    return { ok: true, ...botEngine.getState() };
  });

  app.get('/api/bot/state', async () => {
    return buildApiBotState();
  });


  app.post('/api/bot/kill', async () => {
    killInProgress = true;
    killCompletedAt = null;
    killWarning = null;
    broadcastBotState();

    const result = await botEngine.killSwitch((symbol) => marketHub.getState(symbol));
    const warning =
      result.warning ??
      (result.activeOrdersRemaining > 0 || result.openPositionsRemaining > 0
        ? `KILL finished with remaining activeOrders=${result.activeOrdersRemaining}, openPositions=${result.openPositionsRemaining}`
        : null);

    killWarning = warning;
    killInProgress = false;
    killCompletedAt = Date.now();
    botEngine.stop();
    currentRunProfileNameUsed = null;
    currentRunId = null;
    await runRecorder.writeStats(botEngine.getStats() as unknown as Record<string, unknown>);
    await runRecorder.appendEvent({
      ts: Date.now(),
      type: 'SYSTEM',
      event: 'BOT_KILL',
      payload: {
        cancelledOrders: result.cancelledOrders,
        closedPositions: result.closedPositions,
        activeOrdersRemaining: result.activeOrdersRemaining,
        openPositionsRemaining: result.openPositionsRemaining,
        warning
      }
    });
    broadcastBotState();

    await appendOpsJournalEvent('BOT_KILL', {
      cancelledOrders: result.cancelledOrders,
      closedPositions: result.closedPositions,
      activeOrdersRemaining: result.activeOrdersRemaining,
      openPositionsRemaining: result.openPositionsRemaining,
      warning
    });

    return { ok: true, ...result, warning };
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
    if (botState.running || botState.paused) {
      return reply.code(409).send({ ok: false, error: 'BOT_RUNNING', message: 'Reset all is STOP-only.' });
    }

    await replayService.stopRecording();
    await replayService.stopReplay();

    botEngine.stop();
    botEngine.resetStats();
    botEngine.resetRuntimeStateForAllSymbols();

    await journalService.clear();
    await universeExclusionsService.clear('operator');
    await universeService.clear();
    await marketHub.setUniverseSymbols([]);
    botEngine.setUniverseSymbols([]);
    symbolUpdateBroadcaster.setTrackedSymbols([]);
    symbolUpdateBroadcaster.reset();
    rotatePerfWindow(Date.now());
    botEngine.clearPersistedRuntime();

    await appendOpsJournalEvent('SYSTEM_RESET_ALL');
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

  app.post('/api/bot/clearAllTables', async (_request, reply) => {
    const response = await app.inject({ method: 'POST', url: '/api/reset/all', payload: {} });
    return reply.code(response.statusCode).send(response.json());
  });

  app.get('/api/doctor', async () => {
    try {
      return await doctorService.buildReport();
    } catch (error) {
      app.log.warn({ err: error }, 'doctor report build failed unexpectedly');
      return {
        ok: false,
        ts: Date.now(),
        checks: [{ id: 'doctor_internal', status: 'FAIL', message: 'doctor internal error' }],
        warnings: [(error as Error).message]
      };
    }
  });

  app.post('/api/replay/record/start', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.post('/api/replay/record/stop', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/runs', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/runs/summary', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/runs/:id/download', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/runs/:id/events', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/autotune/state', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

  app.get('/api/autotune/history', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));

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

  app.get('/api/export/pack', async (_request, reply) => reply.code(404).send({ ok: false, error: 'REMOVED_IN_V2' }));


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
    if (!result.ok) {
      const lastKnownUniverseAvailable = !!result.state;
      return reply.code(502).send({
        ok: false,
        ready: false,
        createdAt: result.createdAt,
        filters: result.filters,
        totals: result.totals,
        diagnostics: result.diagnostics,
        upstreamStatus: result.diagnostics.upstreamStatus,
        upstreamError: result.diagnostics.upstreamError,
        lastKnownUniverseAvailable
      });
    }

    // Keep persisted exclusions across create/refresh; they are applied to effective universe.
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
      ready: result.ready,
      totals: result.totals,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive,
      contractFilter: result.state.contractFilter,
      filteredOut: result.state.filteredOut,
      diagnostics: result.diagnostics,
      upstreamStatus: result.diagnostics.upstreamStatus
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

    if (!result.ok) {
      const lastKnownUniverseAvailable = !!result.state;
      return reply.code(502).send({
        ok: false,
        ready: false,
        refreshedAt: result.createdAt,
        filters: result.filters,
        totals: result.totals,
        diagnostics: result.diagnostics,
        upstreamStatus: result.diagnostics.upstreamStatus,
        upstreamError: result.diagnostics.upstreamError,
        lastKnownUniverseAvailable
      });
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
      ready: result.ready,
      totals: result.totals,
      passed: result.state.symbols.length,
      forcedActive: result.forcedActive,
      contractFilter: result.state.contractFilter,
      filteredOut: result.state.filteredOut,
      diagnostics: result.diagnostics,
      upstreamStatus: result.diagnostics.upstreamStatus
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
    return { ok: true, schemaVersion: state.schemaVersion, symbols: state.symbols, excluded: state.symbols, updatedAt: state.updatedAt, source: state.source };
  });

  app.post('/api/universe/exclusions/add', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const botState = botEngine.getState();
    if (botState.running || botState.paused) {
      return reply.code(409).send({ ok: false, error: 'BOT_RUNNING', message: 'Exclusions are STOP-only.' });
    }

    const universe = await universeService.get();
    const warnings: string[] = [];
    if (!universe?.ready) {
      warnings.push('UNIVERSE_NOT_READY_VALIDATION_SKIPPED');
    } else if (!universe.symbols.some((entry) => entry.symbol === symbol)) {
      warnings.push('SYMBOL_NOT_IN_UNIVERSE');
    }

    const persisted = await universeExclusionsService.add(symbol, 'operator');
    warnings.push(...persisted.warnings);
    const effectiveEntries = await getEffectiveUniverseEntries(universe?.symbols ?? []);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, schemaVersion: persisted.state.schemaVersion, symbols: persisted.state.symbols, excluded: persisted.state.symbols, updatedAt: persisted.state.updatedAt, warnings: warnings.length ? warnings : undefined };
  });

  app.post('/api/universe/exclusions/remove', async (request, reply) => {
    const body = request.body as { symbol?: unknown };
    const symbol = typeof body?.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      return reply.code(400).send({ ok: false, error: 'INVALID_SYMBOL' });
    }

    const botState = botEngine.getState();
    if (botState.running || botState.paused) {
      return reply.code(409).send({ ok: false, error: 'BOT_RUNNING', message: 'Exclusions are STOP-only.' });
    }

    const universe = await universeService.get();
    const persisted = await universeExclusionsService.remove(symbol);
    const warnings: string[] = [...persisted.warnings];
    if (!universe?.ready) {
      warnings.push('UNIVERSE_NOT_READY_VALIDATION_SKIPPED');
    }
    const effectiveEntries = await getEffectiveUniverseEntries(universe?.symbols ?? []);
    const symbols = effectiveEntries.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(effectiveEntries);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, schemaVersion: persisted.state.schemaVersion, symbols: persisted.state.symbols, excluded: persisted.state.symbols, updatedAt: persisted.state.updatedAt, warnings: warnings.length ? warnings : undefined };
  });

  app.post('/api/universe/exclusions/clear', async (_request, reply) => {
    const botState = botEngine.getState();
    if (botState.running || botState.paused) {
      return reply.code(409).send({ ok: false, error: 'BOT_RUNNING', message: 'Exclusions are STOP-only.' });
    }

    const universe = await universeService.get();
    if (!universe?.ready) {
      return reply.code(400).send({ ok: false, error: 'UNIVERSE_NOT_READY' });
    }

    const persisted = await universeExclusionsService.clear('operator');
    const symbols = universe.symbols.map((entry) => entry.symbol);
    await marketHub.setUniverseSymbols(symbols);
    botEngine.setUniverseEntries(universe.symbols);
    symbolUpdateBroadcaster.setTrackedSymbols(symbols);
    return { ok: true, schemaVersion: persisted.state.schemaVersion, symbols: persisted.state.symbols, excluded: persisted.state.symbols, updatedAt: persisted.state.updatedAt, warnings: persisted.warnings.length ? persisted.warnings : undefined };
  });

  app.get('/api/universe', async () => {
    const state = await universeService.get();
    const lastUpstreamError = universeService.getLastUpstreamError();
    if (!state) {
      return {
        ok: false,
        ready: false,
        upstreamStatus: lastUpstreamError ? 'error' : 'ok',
        upstreamError: lastUpstreamError ?? undefined,
        lastKnownUniverseAvailable: false
      };
    }

    const exclusions = await universeExclusionsService.get();
    return {
      ok: true,
      ...state,
      excluded: exclusions.symbols,
      upstreamStatus: lastUpstreamError ? 'error' : 'ok',
      upstreamError: lastUpstreamError ?? undefined,
      lastKnownUniverseAvailable: true
    };
  });

  app.get('/api/universe/download', async (_request, reply) => {
    const state = await universeService.get();
    if (!state) {
      return reply.code(404).send({ ok: false, error: 'UNIVERSE_NOT_FOUND' });
    }

    return reply.type('application/json').send(state);
  });

  app.post('/api/universe/clear', async () => {
    await universeService.clear();
    await universeExclusionsService.clear('operator');
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

  runtimeHandlesByApp.set(app, { botEngine, runRecorder, journalService });

  return app;
}

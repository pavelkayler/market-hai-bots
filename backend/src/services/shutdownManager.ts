import type { FastifyBaseLogger } from 'fastify';

import type { BotEngine } from '../bot/botEngine.js';
import type { JournalService } from './journalService.js';
import type { RunRecorderService } from './runRecorderService.js';

type SignalName = 'SIGINT' | 'SIGTERM';
type CrashEvent = 'uncaughtException' | 'unhandledRejection';

type ProcessRef = Pick<NodeJS.Process, 'on' | 'off' | 'exit' | 'once'>;

type RegisterHandlersParams = {
  botEngine: BotEngine;
  runRecorder: RunRecorderService;
  journalService: JournalService;
  logger: FastifyBaseLogger;
  processRef?: ProcessRef;
  now?: () => number;
  exit?: (code: number) => never | void;
};

const sanitizeError = (error: unknown): Record<string, unknown> => {
  if (!error) {
    return { message: 'unknown error' };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stackTop: error.stack?.split('\n').slice(0, 2).join(' | ')
    };
  }

  return { message: String(error) };
};

export const registerHandlers = ({
  botEngine,
  runRecorder,
  journalService,
  logger,
  processRef = process,
  now = Date.now,
  exit = (code) => processRef.exit(code)
}: RegisterHandlersParams): (() => void) => {
  let shuttingDown = false;

  const appendTerminalEvents = async (event: 'BOT_SHUTDOWN' | 'BOT_CRASH', data: Record<string, unknown>): Promise<void> => {
    const mode = botEngine.getState().config?.mode ?? 'paper';
    const ts = now();

    await runRecorder.appendEvent({ ts, type: 'SYSTEM', event, data });

    try {
      await journalService.append({
        ts,
        mode,
        symbol: 'SYSTEM',
        event,
        side: null,
        data
      });
    } catch (error) {
      logger.warn({ err: error, event }, 'failed to append shutdown/crash journal event');
    }
  };

  const bestEffortStopAndPersist = async (): Promise<void> => {
    try {
      botEngine.stop();
    } catch (error) {
      logger.error({ err: error }, 'botEngine.stop failed during shutdown');
    }

    try {
      await runRecorder.writeStats(botEngine.getStats() as unknown as Record<string, unknown>);
    } catch (error) {
      logger.error({ err: error }, 'runRecorder.writeStats failed during shutdown');
    }
  };

  const onSignal = async (signal: SignalName): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const state = botEngine.getState();
    const active = state.running || state.paused;
    logger.warn({ signal, running: state.running, paused: state.paused }, 'shutdown signal received');

    if (active) {
      await appendTerminalEvents('BOT_SHUTDOWN', { reason: signal });
    }

    await bestEffortStopAndPersist();
    exit(0);
  };

  const onCrash = async (event: CrashEvent, error: unknown): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    const errorSummary = sanitizeError(error);
    logger.error({ event, error: errorSummary }, 'fatal process error');

    await appendTerminalEvents('BOT_CRASH', { reason: event, error: errorSummary });
    await bestEffortStopAndPersist();
    exit(1);
  };

  const signalHandlers: Record<SignalName, () => void> = {
    SIGINT: () => {
      void onSignal('SIGINT');
    },
    SIGTERM: () => {
      void onSignal('SIGTERM');
    }
  };

  const crashHandlers: Record<CrashEvent, (error: unknown) => void> = {
    uncaughtException: (error) => {
      void onCrash('uncaughtException', error);
    },
    unhandledRejection: (error) => {
      void onCrash('unhandledRejection', error);
    }
  };

  processRef.on('SIGINT', signalHandlers.SIGINT);
  processRef.on('SIGTERM', signalHandlers.SIGTERM);
  processRef.on('uncaughtException', crashHandlers.uncaughtException);
  processRef.on('unhandledRejection', crashHandlers.unhandledRejection);

  return () => {
    processRef.off('SIGINT', signalHandlers.SIGINT);
    processRef.off('SIGTERM', signalHandlers.SIGTERM);
    processRef.off('uncaughtException', crashHandlers.uncaughtException);
    processRef.off('unhandledRejection', crashHandlers.unhandledRejection);
  };
};

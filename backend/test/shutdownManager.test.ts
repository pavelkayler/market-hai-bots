import { describe, expect, it, vi } from 'vitest';

import { registerHandlers } from '../src/services/shutdownManager.js';

const createFakeProcess = () => {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
      return this;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      const arr = handlers.get(event) ?? [];
      handlers.set(
        event,
        arr.filter((entry) => entry !== handler)
      );
      return this;
    },
    once(event: string, handler: (...args: unknown[]) => void) {
      this.on(event, handler);
      return this;
    },
    exit: vi.fn(),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  };
};

describe('shutdownManager', () => {
  it('records BOT_SHUTDOWN and stops bot on SIGINT', async () => {
    const fakeProcess = createFakeProcess();
    const botEngine = {
      getState: vi.fn(() => ({ running: true, paused: false, config: { mode: 'paper' } })),
      stop: vi.fn(),
      getStats: vi.fn(() => ({ pnlUSDT: 0 }))
    };
    const runRecorder = {
      appendEvent: vi.fn(async () => {}),
      writeStats: vi.fn(async () => {})
    };
    const journalService = {
      append: vi.fn(async () => {})
    };
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    const exit = vi.fn();

    registerHandlers({
      botEngine: botEngine as never,
      runRecorder: runRecorder as never,
      journalService: journalService as never,
      logger: logger as never,
      processRef: fakeProcess as never,
      exit
    });

    fakeProcess.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runRecorder.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'BOT_SHUTDOWN' }));
    expect(journalService.append).toHaveBeenCalledWith(expect.objectContaining({ event: 'BOT_SHUTDOWN' }));
    expect(botEngine.stop).toHaveBeenCalledTimes(1);
    expect(runRecorder.writeStats).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('records BOT_CRASH and exits non-zero on unhandledRejection', async () => {
    const fakeProcess = createFakeProcess();
    const botEngine = {
      getState: vi.fn(() => ({ running: false, paused: false, config: { mode: 'paper' } })),
      stop: vi.fn(),
      getStats: vi.fn(() => ({ pnlUSDT: -10 }))
    };
    const runRecorder = {
      appendEvent: vi.fn(async () => {}),
      writeStats: vi.fn(async () => {})
    };
    const journalService = {
      append: vi.fn(async () => {})
    };
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    const exit = vi.fn();

    registerHandlers({
      botEngine: botEngine as never,
      runRecorder: runRecorder as never,
      journalService: journalService as never,
      logger: logger as never,
      processRef: fakeProcess as never,
      exit
    });

    fakeProcess.emit('unhandledRejection', new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runRecorder.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'BOT_CRASH' }));
    expect(journalService.append).toHaveBeenCalledWith(expect.objectContaining({ event: 'BOT_CRASH' }));
    expect(botEngine.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

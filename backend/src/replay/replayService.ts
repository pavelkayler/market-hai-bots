import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { MarketState } from '../market/marketHub.js';
import type { UniverseState } from '../types/universe.js';

export type ReplaySpeed = '1x' | '5x' | '20x' | 'fast';

export type ReplayTick = {
  ts: number;
  symbol: string;
  markPrice: number;
  openInterestValue: number;
};

type ReplayServiceDeps = {
  getUniverse: () => Promise<UniverseState | null>;
  getCurrentBotMode: () => 'paper' | 'demo' | null;
  isBotRunning: () => boolean;
  disableLiveMarket: () => Promise<void>;
  enableLiveMarket: () => Promise<void>;
  feedTick: (symbol: string, state: MarketState) => void;
  subscribeMarketTicks: (handler: (symbol: string, state: MarketState) => void) => () => void;
  log: (message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  replayDir?: string;
};

type RecordingState = {
  fileName: string;
  path: string;
  startedAt: number;
  recordsWritten: number;
};

type ReplayState = {
  fileName: string;
  speed: ReplaySpeed;
  startedAt: number;
  read: number;
  total: number;
};

const RECORD_THROTTLE_MS = 500;

const parseLine = (line: string): ReplayTick | null => {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const payload = parsed as Partial<ReplayTick>;
  if (
    typeof payload.ts !== 'number' ||
    !Number.isFinite(payload.ts) ||
    typeof payload.symbol !== 'string' ||
    typeof payload.markPrice !== 'number' ||
    !Number.isFinite(payload.markPrice) ||
    typeof payload.openInterestValue !== 'number' ||
    !Number.isFinite(payload.openInterestValue)
  ) {
    return null;
  }

  return payload as ReplayTick;
};

const speedDivider = (speed: ReplaySpeed): number => {
  if (speed === '1x') {
    return 1;
  }

  if (speed === '5x') {
    return 5;
  }

  return 20;
};

export class ReplayService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly replayDir: string;
  private recording: RecordingState | null = null;
  private replay: ReplayState | null = null;
  private recordStream: WriteStream | null = null;
  private unsubscribeRecord: (() => void) | null = null;
  private readonly lastWrittenAtBySymbol = new Map<string, number>();
  private replayAbortController: AbortController | null = null;

  constructor(private readonly deps: ReplayServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.replayDir = deps.replayDir ?? path.resolve(process.cwd(), 'data/replay');
  }

  async startRecording(fileName: string, topN = 20): Promise<{ path: string; startedAt: number }> {
    if (this.recording || this.replay) {
      throw new Error('REPLAY_BUSY');
    }

    const universe = await this.deps.getUniverse();
    if (!universe?.ready || universe.symbols.length === 0) {
      throw new Error('UNIVERSE_NOT_READY');
    }

    await mkdir(this.replayDir, { recursive: true });

    const safeFileName = path.basename(fileName);
    const outputPath = path.join(this.replayDir, safeFileName);
    const stream = createWriteStream(outputPath, { flags: 'w' });

    const allowedSymbols = new Set(
      [...universe.symbols]
        .sort((a, b) => b.turnover24h - a.turnover24h)
        .slice(0, Math.max(1, topN))
        .map((entry) => entry.symbol)
    );

    this.lastWrittenAtBySymbol.clear();
    this.recordStream = stream;
    this.recording = {
      fileName: safeFileName,
      path: outputPath,
      startedAt: this.now(),
      recordsWritten: 0
    };

    this.unsubscribeRecord = this.deps.subscribeMarketTicks((symbol, state) => {
      if (!allowedSymbols.has(symbol) || !this.recording || !this.recordStream) {
        return;
      }

      const lastWrittenAt = this.lastWrittenAtBySymbol.get(symbol) ?? 0;
      if (state.ts - lastWrittenAt < RECORD_THROTTLE_MS) {
        return;
      }

      const line: ReplayTick = {
        ts: state.ts,
        symbol,
        markPrice: state.markPrice,
        openInterestValue: state.openInterestValue
      };

      this.recordStream.write(`${JSON.stringify(line)}\n`);
      this.lastWrittenAtBySymbol.set(symbol, state.ts);
      this.recording.recordsWritten += 1;
    });

    this.deps.log(`Recording started (${safeFileName})`);
    return { path: outputPath, startedAt: this.recording.startedAt };
  }

  async stopRecording(): Promise<{ stoppedAt: number; recordsWritten: number }> {
    if (!this.recording) {
      return { stoppedAt: this.now(), recordsWritten: 0 };
    }

    this.unsubscribeRecord?.();
    this.unsubscribeRecord = null;
    this.lastWrittenAtBySymbol.clear();

    const recordsWritten = this.recording.recordsWritten;
    const stream = this.recordStream;
    this.recordStream = null;

    if (stream) {
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    }

    this.recording = null;
    const stoppedAt = this.now();
    this.deps.log('Recording stopped');
    return { stoppedAt, recordsWritten };
  }

  async startReplay(fileName: string, speed: ReplaySpeed): Promise<{ startedAt: number }> {
    if (this.recording || this.replay) {
      throw new Error('REPLAY_BUSY');
    }

    const mode = this.deps.getCurrentBotMode();
    if (this.deps.isBotRunning() && mode !== 'paper') {
      throw new Error('REPLAY_REQUIRES_PAPER_MODE');
    }

    const safeFileName = path.basename(fileName);
    const filePath = path.join(this.replayDir, safeFileName);
    const source = createReadStream(filePath, 'utf-8');
    const lineReader = readline.createInterface({ input: source, crlfDelay: Infinity });

    let total = 0;
    for await (const line of lineReader) {
      if (line.trim()) {
        total += 1;
      }
    }

    await this.deps.disableLiveMarket();

    const startedAt = this.now();
    this.replay = {
      fileName: safeFileName,
      speed,
      startedAt,
      read: 0,
      total
    };
    this.replayAbortController = new AbortController();
    this.deps.log(`Replay started (${safeFileName}, ${speed})`);

    void this.runReplay(filePath, speed, this.replayAbortController.signal);

    return { startedAt };
  }

  async stopReplay(): Promise<{ stoppedAt: number }> {
    if (!this.replay) {
      return { stoppedAt: this.now() };
    }

    this.replayAbortController?.abort();
    this.replayAbortController = null;
    this.replay = null;
    await this.deps.enableLiveMarket();

    const stoppedAt = this.now();
    this.deps.log('Replay stopped');
    return { stoppedAt };
  }

  getState(): {
    recording: boolean;
    replaying: boolean;
    fileName: string | null;
    speed: ReplaySpeed | null;
    recordsWritten: number;
    progress: { read: number; total: number };
  } {
    return {
      recording: !!this.recording,
      replaying: !!this.replay,
      fileName: this.recording?.fileName ?? this.replay?.fileName ?? null,
      speed: this.replay?.speed ?? null,
      recordsWritten: this.recording?.recordsWritten ?? 0,
      progress: {
        read: this.replay?.read ?? 0,
        total: this.replay?.total ?? 0
      }
    };
  }

  async listFiles(): Promise<string[]> {
    await mkdir(this.replayDir, { recursive: true });
    const entries = await readdir(this.replayDir);
    const details = await Promise.all(entries.map(async (entry) => ({ entry, stat: await stat(path.join(this.replayDir, entry)) })));

    return details
      .filter(({ stat: fileStat, entry }) => fileStat.isFile() && entry.endsWith('.ndjson'))
      .map(({ entry }) => entry)
      .sort((a, b) => a.localeCompare(b));
  }

  private async runReplay(filePath: string, speed: ReplaySpeed, signal: AbortSignal): Promise<void> {
    let previousTick: ReplayTick | null = null;
    try {
      const source = createReadStream(filePath, 'utf-8');
      const lineReader = readline.createInterface({ input: source, crlfDelay: Infinity });

      for await (const line of lineReader) {
        if (signal.aborted || !this.replay) {
          break;
        }

        const tick = parseLine(line);
        if (!tick) {
          continue;
        }

        if (previousTick && speed !== 'fast') {
          const delayMs = Math.max(0, tick.ts - previousTick.ts) / speedDivider(speed);
          if (delayMs > 0) {
            await this.sleep(delayMs);
          }
        }

        previousTick = tick;
        this.deps.feedTick(tick.symbol, {
          markPrice: tick.markPrice,
          openInterestValue: tick.openInterestValue,
          ts: tick.ts,
          lastPrice: null,
          bid: null,
          ask: null,
          spreadBps: null,
          lastTickTs: tick.ts
        });

        this.replay.read += 1;
      }
    } finally {
      if (this.replay) {
        this.replay = null;
        this.replayAbortController = null;
        await this.deps.enableLiveMarket();
        this.deps.log('Replay stopped');
      }
    }
  }
}

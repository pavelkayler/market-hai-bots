import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BotConfig, BotStats, BothCandidateDiagnostics, DemoRuntimeState, EntryReason, GateSnapshot, SymbolBaseline, SymbolFsmState } from './botEngine.js';
import type { PaperPendingOrder, PaperPosition } from './paperTypes.js';

export type RuntimeSnapshotSymbol = {
  fsmState: SymbolFsmState;
  baseline: SymbolBaseline | null;
  blockedUntilTs: number;
  overrideGateOnce: boolean;
  pendingOrder: PaperPendingOrder | null;
  position: PaperPosition | null;
  demo: DemoRuntimeState | null;
  signalEvents?: number[];
  lastSignalBucketKey?: number | null;
  prevCandleOi?: number | null;
  lastCandleOi?: number | null;
  lastCandleBucketStart?: number | null;
  trend5mBucketStart?: number | null;
  trend5mPrevClose?: number | null;
  trend5mLastClose?: number | null;
  trend15mBucketStart?: number | null;
  trend15mPrevClose?: number | null;
  trend15mLastClose?: number | null;
  armedSignal?: {
    side: 'LONG' | 'SHORT';
    baselinePrice?: number;
    armedBucketStart?: number;
    expireBucketStart?: number;
    triggerMark?: number;
    triggerBucketStart?: number;
    continuationWindowEndBucketStart?: number;
  } | null;
  lastNoEntryReasons?: Array<{ code: string; message: string; value?: number; threshold?: number }>;
  entryReason?: EntryReason | null;
  lastPriceDeltaPct?: number | null;
  lastOiDeltaPct?: number | null;
  lastSignalCount24h?: number;
  gates?: GateSnapshot | null;
  lastBothCandidate?: BothCandidateDiagnostics | null;
};

export type RuntimeSnapshot = {
  savedAt: number;
  paused: boolean;
  running: boolean;
  runningSinceTs?: number | null;
  activeUptimeMs?: number;
  config: BotConfig | null;
  symbols: Record<string, RuntimeSnapshotSymbol>;
  stats?: BotStats;
};

export interface SnapshotStore {
  load(): RuntimeSnapshot | null;
  save(snapshot: RuntimeSnapshot): void;
  clear(): void;
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/runtime.json')) {}

  load(): RuntimeSnapshot | null {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as RuntimeSnapshot;
      if (!parsed || typeof parsed.savedAt !== 'number' || typeof parsed.paused !== 'boolean' || typeof parsed.running !== 'boolean') {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  save(snapshot: RuntimeSnapshot): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    renameSync(tmpPath, this.filePath);
  }

  clear(): void {
    rmSync(this.filePath, { force: true });
  }
}

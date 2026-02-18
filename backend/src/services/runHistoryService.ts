import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type RunSummary = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode?: string | null;
  tf?: number | null;
  direction?: string | null;
  strategyMode?: string | null;
  universeSymbols?: number | null;
  hasStats: boolean;
  stats?: {
    totalTrades: number;
    winratePct: number;
    pnlUSDT: number;
    totalFeesUSDT?: number;
    totalSlippageUSDT?: number;
  };
  tradedSymbols?: string[];
  warnings?: string[];
};

type StatsLike = {
  totalTrades?: unknown;
  winratePct?: unknown;
  pnlUSDT?: unknown;
  totalFeesUSDT?: unknown;
  totalSlippageUSDT?: unknown;
};

type MetaLike = {
  startTime?: unknown;
  endTime?: unknown;
  configSnapshot?: {
    mode?: unknown;
    tf?: unknown;
    direction?: unknown;
    strategyMode?: unknown;
  };
  universeSummary?: {
    total?: unknown;
    effective?: unknown;
  };
};

export class RunHistoryService {
  constructor(private readonly baseDir = path.resolve(process.cwd(), 'data/runs')) {}

  async summarizeRecent(limit: number): Promise<RunSummary[]> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const runIds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(1, Math.floor(limit)));

    const summaries: RunSummary[] = [];
    for (const runId of runIds) {
      summaries.push(await this.summarizeRun(runId));
    }

    return summaries;
  }

  private async summarizeRun(runId: string): Promise<RunSummary> {
    const warnings: string[] = [];
    const runDir = path.join(this.baseDir, runId);
    const metaRaw = await readFile(path.join(runDir, 'meta.json'), 'utf-8').catch(() => null);

    let meta: MetaLike = {};
    if (typeof metaRaw !== 'string') {
      warnings.push('meta.json missing');
    } else {
      try {
        meta = JSON.parse(metaRaw) as MetaLike;
      } catch {
        warnings.push('meta.json parse failed');
      }
    }

    const startedAt = typeof meta.startTime === 'number' ? meta.startTime : Date.parse(runId.replaceAll('-', ':')) || 0;
    const endedAt = typeof meta.endTime === 'number' ? meta.endTime : null;

    const summary: RunSummary = {
      id: runId,
      startedAt,
      endedAt,
      mode: typeof meta.configSnapshot?.mode === 'string' ? meta.configSnapshot.mode : null,
      tf: typeof meta.configSnapshot?.tf === 'number' ? meta.configSnapshot.tf : null,
      direction: typeof meta.configSnapshot?.direction === 'string' ? meta.configSnapshot.direction : null,
      strategyMode: typeof meta.configSnapshot?.strategyMode === 'string' ? meta.configSnapshot.strategyMode : null,
      universeSymbols: typeof meta.universeSummary?.effective === 'number'
        ? meta.universeSummary.effective
        : typeof meta.universeSummary?.total === 'number'
          ? meta.universeSummary.total
          : null,
      hasStats: false
    };

    const statsRaw = await readFile(path.join(runDir, 'stats.json'), 'utf-8').catch(() => null);
    if (typeof statsRaw === 'string') {
      try {
        const parsed = JSON.parse(statsRaw) as StatsLike;
        summary.stats = {
          totalTrades: typeof parsed.totalTrades === 'number' ? parsed.totalTrades : 0,
          winratePct: typeof parsed.winratePct === 'number' ? parsed.winratePct : 0,
          pnlUSDT: typeof parsed.pnlUSDT === 'number' ? parsed.pnlUSDT : 0,
          ...(typeof parsed.totalFeesUSDT === 'number' ? { totalFeesUSDT: parsed.totalFeesUSDT } : {}),
          ...(typeof parsed.totalSlippageUSDT === 'number' ? { totalSlippageUSDT: parsed.totalSlippageUSDT } : {})
        };
        summary.hasStats = true;
      } catch {
        warnings.push('stats.json parse failed');
      }
    }

    const eventsRaw = await readFile(path.join(runDir, 'events.ndjson'), 'utf-8').catch(() => null);
    if (typeof eventsRaw === 'string' && eventsRaw.trim().length > 0) {
      const traded = new Set<string>();
      for (const line of eventsRaw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            payload?: { symbol?: string; status?: string };
          };
          const symbol = typeof event.payload?.symbol === 'string' ? event.payload.symbol : null;
          if (!symbol) continue;
          if (
            event.type === 'position:update' ||
            event.type === 'order:update'
          ) {
            traded.add(symbol);
          }
        } catch {
          warnings.push('events.ndjson line parse failed');
          break;
        }
      }
      if (traded.size > 0) {
        summary.tradedSymbols = Array.from(traded).sort((a, b) => a.localeCompare(b));
      }
    }

    if (warnings.length > 0) {
      summary.warnings = warnings;
    }

    return summary;
  }
}

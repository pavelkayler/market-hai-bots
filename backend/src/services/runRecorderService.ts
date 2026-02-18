import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type RunSummary = { id: string; startedAt: string; hasMeta: boolean; hasEvents: boolean };

export class RunRecorderService {
  private currentRunDir: string | null = null;

  constructor(private readonly baseDir = path.resolve(process.cwd(), 'data/runs')) {}

  async startRun(meta: Record<string, unknown>): Promise<{ runId: string; runDir: string } | null> {
    const runId = new Date().toISOString().replaceAll(':', '-');
    const runDir = path.join(this.baseDir, runId);
    try {
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
      await writeFile(path.join(runDir, 'events.ndjson'), '', 'utf-8');
      this.currentRunDir = runDir;
      return { runId, runDir };
    } catch {
      return null;
    }
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.currentRunDir) return;
    try {
      await writeFile(path.join(this.currentRunDir, 'events.ndjson'), `${JSON.stringify(event)}\n`, { encoding: 'utf-8', flag: 'a' });
    } catch {
      // swallow write failures
    }
  }

  async writeStats(stats: Record<string, unknown>): Promise<void> {
    if (!this.currentRunDir) return;
    try {
      await writeFile(path.join(this.currentRunDir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf-8');
    } catch {
      // swallow write failures
    }
  }

  async listRecent(limit: number): Promise<RunSummary[]> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a)).slice(0, limit);
      const result: RunSummary[] = [];
      for (const id of dirs) {
        const runDir = path.join(this.baseDir, id);
        const metaPath = path.join(runDir, 'meta.json');
        const eventsPath = path.join(runDir, 'events.ndjson');
        let hasMeta = false;
        let hasEvents = false;
        try { await stat(metaPath); hasMeta = true; } catch {}
        try { await stat(eventsPath); hasEvents = true; } catch {}
        result.push({ id, startedAt: id.replaceAll('-', ':'), hasMeta, hasEvents });
      }
      return result;
    } catch {
      return [];
    }
  }

  async getRunPayload(runId: string): Promise<Record<string, string> | null> {
    const runDir = path.join(this.baseDir, runId);
    try {
      const [meta, events] = await Promise.all([
        readFile(path.join(runDir, 'meta.json'), 'utf-8').catch(() => ''),
        readFile(path.join(runDir, 'events.ndjson'), 'utf-8').catch(() => '')
      ]);
      return { 'meta.json': meta, 'events.ndjson': events };
    } catch {
      return null;
    }
  }

  getCurrentRunDir(): string | null {
    return this.currentRunDir;
  }
}

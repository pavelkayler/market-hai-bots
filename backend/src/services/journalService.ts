import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type JournalMode = 'paper' | 'demo';
export type JournalEvent =
  | 'SIGNAL'
  | 'ORDER_PLACED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_EXPIRED'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED'
  | 'BOT_PAUSE'
  | 'BOT_RESUME'
  | 'BOT_KILL';

export type JournalEntry = {
  ts: number;
  mode: JournalMode;
  symbol: string;
  event: JournalEvent;
  side: 'LONG' | 'SHORT' | null;
  data: Record<string, unknown>;
};

const DEFAULT_ROTATE_BYTES = 50 * 1024 * 1024;

export class JournalService {
  constructor(
    private readonly filePath: string,
    private readonly rotateBytes: number = DEFAULT_ROTATE_BYTES
  ) {}

  async append(entry: JournalEntry): Promise<void> {
    await this.ensureDir();
    await this.rotateIfNeeded();
    await writeFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8', flag: 'a' });
  }

  async tail(limit: number): Promise<JournalEntry[]> {
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const content = await this.readRaw();
    if (!content) {
      return [];
    }

    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const selected = lines.slice(Math.max(0, lines.length - Math.floor(limit)));
    return selected
      .map((line) => {
        try {
          return JSON.parse(line) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is JournalEntry => entry !== null);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  async readRaw(): Promise<string> {
    try {
      return await readFile(this.filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async ensureDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const fileStat = await stat(this.filePath);
      if (fileStat.size <= this.rotateBytes) {
        return;
      }

      const rotatedName = `journal-${Date.now()}.ndjson`;
      await rename(this.filePath, path.join(path.dirname(this.filePath), rotatedName));
    } catch {
      // missing journal file or rotate failure: continue append flow
    }
  }
}

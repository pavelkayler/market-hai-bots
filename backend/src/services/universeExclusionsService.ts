import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type UniverseExclusionsState = {
  schemaVersion: 1;
  updatedAt: number;
  symbols: string[];
  source?: 'operator' | 'autotune';
};

export type UniverseExclusionsPersistResult = {
  state: UniverseExclusionsState;
  warnings: string[];
};

const emptyState = (): UniverseExclusionsState => ({
  schemaVersion: 1,
  updatedAt: Date.now(),
  symbols: []
});

const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

const formatPart = (value: number): string => value.toString().padStart(2, '0');

const toTimestampName = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${formatPart(d.getUTCMonth() + 1)}${formatPart(d.getUTCDate())}-${formatPart(d.getUTCHours())}${formatPart(d.getUTCMinutes())}${formatPart(d.getUTCSeconds())}`;
};

export class UniverseExclusionsService {
  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/universe-exclusions.json')) {}

  private async readCurrent(): Promise<UniverseExclusionsState> {
    try {
      await access(this.filePath);
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as Partial<UniverseExclusionsState> & { excluded?: unknown[] };
      const symbolsRaw = Array.isArray(parsed.symbols) ? parsed.symbols : Array.isArray(parsed.excluded) ? parsed.excluded : [];
      return {
        schemaVersion: 1,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        symbols: Array.from(new Set(symbolsRaw.filter((entry): entry is string => typeof entry === 'string').map(normalizeSymbol))),
        source: parsed.source === 'operator' || parsed.source === 'autotune' ? parsed.source : undefined
      };
    } catch {
      return emptyState();
    }
  }

  async get(): Promise<UniverseExclusionsState> {
    return this.readCurrent();
  }

  private getLegacyFilePath(): string {
    return path.join(path.dirname(this.filePath), 'universe_exclusions.json');
  }

  private async persist(state: UniverseExclusionsState): Promise<UniverseExclusionsPersistResult> {
    const warnings: string[] = [];
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(state, null, 2);
    try {
      await writeFile(this.filePath, payload, 'utf-8');
      await writeFile(this.getLegacyFilePath(), payload, 'utf-8');
    } catch {
      warnings.push('CURRENT_WRITE_FAILED');
    }

    const snapshotPath = path.join(path.dirname(this.filePath), `universe-exclusions-${toTimestampName(state.updatedAt)}.json`);
    const legacySnapshotPath = path.join(path.dirname(this.filePath), `universe_exclusions_${toTimestampName(state.updatedAt)}.json`);
    try {
      await writeFile(snapshotPath, payload, 'utf-8');
      await writeFile(legacySnapshotPath, payload, 'utf-8');
    } catch {
      warnings.push('SNAPSHOT_WRITE_FAILED');
    }

    return { state, warnings };
  }

  async add(symbol: string, source: 'operator' | 'autotune' = 'operator'): Promise<UniverseExclusionsPersistResult> {
    const normalized = normalizeSymbol(symbol);
    const current = await this.readCurrent();
    const symbols = Array.from(new Set([...current.symbols, normalized]));
    const next: UniverseExclusionsState = { schemaVersion: 1, updatedAt: Date.now(), symbols, source };
    return this.persist(next);
  }

  async remove(symbol: string): Promise<UniverseExclusionsPersistResult> {
    const normalized = normalizeSymbol(symbol);
    const current = await this.readCurrent();
    const symbols = current.symbols.filter((entry) => entry !== normalized);
    const next: UniverseExclusionsState = { schemaVersion: 1, updatedAt: Date.now(), symbols, source: current.source };
    return this.persist(next);
  }

  async clear(source: 'operator' | 'autotune' = 'operator'): Promise<UniverseExclusionsPersistResult> {
    const next: UniverseExclusionsState = { schemaVersion: 1, updatedAt: Date.now(), symbols: [], source };
    return this.persist(next);
  }
}

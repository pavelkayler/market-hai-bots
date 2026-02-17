import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type UniverseExclusionsState = {
  updatedAt: number;
  excluded: string[];
};

const emptyState = (): UniverseExclusionsState => ({
  updatedAt: Date.now(),
  excluded: []
});

const normalizeSymbol = (value: string): string => value.trim().toUpperCase();

const formatPart = (value: number): string => value.toString().padStart(2, '0');

const toTimestampName = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${formatPart(d.getUTCMonth() + 1)}-${formatPart(d.getUTCDate())}_${formatPart(d.getUTCHours())}-${formatPart(d.getUTCMinutes())}-${formatPart(d.getUTCSeconds())}`;
};

export class UniverseExclusionsService {
  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/universe_exclusions.json')) {}

  private async readCurrent(): Promise<UniverseExclusionsState> {
    try {
      await access(this.filePath);
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as Partial<UniverseExclusionsState>;
      return {
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        excluded: Array.isArray(parsed.excluded)
          ? Array.from(new Set(parsed.excluded.filter((entry): entry is string => typeof entry === 'string').map(normalizeSymbol)))
          : []
      };
    } catch {
      return emptyState();
    }
  }

  async get(): Promise<UniverseExclusionsState> {
    return this.readCurrent();
  }

  private async persist(state: UniverseExclusionsState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(state, null, 2);
    await writeFile(this.filePath, payload, 'utf-8');
    const snapshotPath = path.join(path.dirname(this.filePath), `universe_exclusions_${toTimestampName(state.updatedAt)}.json`);
    await writeFile(snapshotPath, payload, 'utf-8');
  }

  async add(symbol: string): Promise<UniverseExclusionsState> {
    const normalized = normalizeSymbol(symbol);
    const current = await this.readCurrent();
    const excluded = Array.from(new Set([...current.excluded, normalized]));
    const next = { updatedAt: Date.now(), excluded };
    await this.persist(next);
    return next;
  }

  async remove(symbol: string): Promise<UniverseExclusionsState> {
    const normalized = normalizeSymbol(symbol);
    const current = await this.readCurrent();
    const excluded = current.excluded.filter((entry) => entry !== normalized);
    const next = { updatedAt: Date.now(), excluded };
    await this.persist(next);
    return next;
  }

  async clear(): Promise<UniverseExclusionsState> {
    const next = { updatedAt: Date.now(), excluded: [] };
    await this.persist(next);
    return next;
  }
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AutoTuneScope = 'GLOBAL' | 'UNIVERSE_ONLY';

type AutoTuneChange = {
  ts: number;
  parameter: string;
  before: number;
  after: number;
  reason: string;
  bounds: { min: number; max: number };
};

export type AutoTuneState = {
  enabled: boolean;
  scope: AutoTuneScope;
  lastApplied: AutoTuneChange | null;
  history: AutoTuneChange[];
  closesSeen: number;
};

const DEFAULT_STATE: AutoTuneState = {
  enabled: false,
  scope: 'GLOBAL',
  lastApplied: null,
  history: [],
  closesSeen: 0
};

export class AutoTuneService {
  private state: AutoTuneState = { ...DEFAULT_STATE };
  private initialized = false;

  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/autotune/state.json')) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AutoTuneState>;
      this.state = {
        enabled: !!parsed.enabled,
        scope: parsed.scope === 'UNIVERSE_ONLY' ? 'UNIVERSE_ONLY' : 'GLOBAL',
        lastApplied: parsed.lastApplied ?? null,
        history: Array.isArray(parsed.history) ? parsed.history.slice(-200) as AutoTuneChange[] : [],
        closesSeen: typeof parsed.closesSeen === 'number' ? parsed.closesSeen : 0
      };
    } catch {
      await this.persist();
    }
  }

  getState(): AutoTuneState {
    return { ...this.state, history: [...this.state.history] };
  }

  async setEnabledScope(enabled: boolean, scope: AutoTuneScope): Promise<void> {
    this.state.enabled = enabled;
    this.state.scope = scope;
    await this.persist();
  }

  async noteApplied(change: Omit<AutoTuneChange, 'ts'>): Promise<AutoTuneChange> {
    const full: AutoTuneChange = { ...change, ts: Date.now() };
    this.state.lastApplied = full;
    this.state.history = [...this.state.history, full].slice(-200);
    this.state.closesSeen += 1;
    await this.persist();
    return full;
  }

  async noteCloseSeen(): Promise<void> {
    this.state.closesSeen += 1;
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // persistence must not crash bot
    }
  }
}

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeBotConfig, type BotConfig } from '../bot/botEngine.js';

type ProfilesFile = {
  activeProfile: string;
  profiles: Record<string, BotConfig>;
};

const DEFAULT_PROFILE_NAME = 'default' as const;

const DEFAULT_PROFILE_CONFIG: BotConfig = {
  mode: 'paper',
  direction: 'both',
  bothTieBreak: 'shortPriority',
  tf: 1,
  strategyMode: 'IMPULSE',
  holdSeconds: 3,
  signalCounterThreshold: 2,
  signalCounterMin: 2,
  signalCounterMax: Number.MAX_SAFE_INTEGER,
  priceUpThrPct: 0.5,
  oiUpThrPct: 50,
  oiCandleThrPct: 0,
  marginUSDT: 100,
  leverage: 10,
  tpRoiPct: 1,
  slRoiPct: 0.7,
  entryOffsetPct: 0.01,
  maxActiveSymbols: 3,
  dailyLossLimitUSDT: 10,
  maxConsecutiveLosses: 3,
  trendTfMinutes: 5,
  trendLookbackBars: 20,
  trendMinMovePct: 0.2,
  confirmWindowBars: 2,
  confirmMinContinuationPct: 0.1,
  impulseMaxAgeBars: 2,
  requireOiTwoCandles: false,
  maxSecondsIntoCandle: 45,
  minSpreadBps: 0,
  maxSpreadBps: 35,
  maxTickStalenessMs: 2500,
  minNotionalUSDT: 5,
  autoTuneEnabled: false,
  autoTuneScope: 'GLOBAL',
  autoTunePlannerMode: 'DETERMINISTIC'
};

const SHIPPED_PRESET_NAMES = [
  'aggressive_1m',
  'aggressive_3m',
  'aggressive_5m',
  'balanced_1m',
  'balanced_3m',
  'balanced_5m',
  'conservative_1m',
  'conservative_3m',
  'conservative_5m',
  'skip_most_trades'
] as const;

const LEGACY_SHIPPED_PRESETS = ['fast_test_1m', 'overnight_1m_safe', 'smoke_min_1m', 'smoke_min_thresholds_1m'] as const;

const SHIPPED_PRESETS: Record<(typeof SHIPPED_PRESET_NAMES)[number], BotConfig> = {
  aggressive_1m: { ...DEFAULT_PROFILE_CONFIG, tf: 1, signalCounterThreshold: 1, signalCounterMin: 1, priceUpThrPct: 0.25, oiUpThrPct: 25, oiCandleThrPct: 0.1, maxActiveSymbols: 6, maxSpreadBps: 55, maxTickStalenessMs: 3000, minNotionalUSDT: 5, autoTuneEnabled: true, autoTuneScope: 'GLOBAL', autoTunePlannerMode: 'RANDOM_EXPLORE' },
  aggressive_3m: { ...DEFAULT_PROFILE_CONFIG, tf: 3, signalCounterThreshold: 1, signalCounterMin: 1, priceUpThrPct: 0.35, oiUpThrPct: 30, oiCandleThrPct: 0.15, maxActiveSymbols: 5, maxSpreadBps: 50, maxTickStalenessMs: 3000, minNotionalUSDT: 6, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  aggressive_5m: { ...DEFAULT_PROFILE_CONFIG, tf: 5, signalCounterThreshold: 2, signalCounterMin: 1, priceUpThrPct: 0.4, oiUpThrPct: 35, oiCandleThrPct: 0.2, maxActiveSymbols: 4, maxSpreadBps: 45, maxTickStalenessMs: 3200, minNotionalUSDT: 8, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  balanced_1m: { ...DEFAULT_PROFILE_CONFIG, tf: 1, signalCounterThreshold: 2, signalCounterMin: 2, priceUpThrPct: 0.5, oiUpThrPct: 45, oiCandleThrPct: 0.25, maxActiveSymbols: 4, maxSpreadBps: 40, maxTickStalenessMs: 2500, minNotionalUSDT: 8, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  balanced_3m: { ...DEFAULT_PROFILE_CONFIG, tf: 3, signalCounterThreshold: 2, signalCounterMin: 2, priceUpThrPct: 0.55, oiUpThrPct: 50, oiCandleThrPct: 0.3, maxActiveSymbols: 3, maxSpreadBps: 38, maxTickStalenessMs: 2500, minNotionalUSDT: 10, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  balanced_5m: { ...DEFAULT_PROFILE_CONFIG, tf: 5, signalCounterThreshold: 2, signalCounterMin: 2, priceUpThrPct: 0.6, oiUpThrPct: 55, oiCandleThrPct: 0.35, maxActiveSymbols: 3, maxSpreadBps: 35, maxTickStalenessMs: 2400, minNotionalUSDT: 12, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  conservative_1m: { ...DEFAULT_PROFILE_CONFIG, tf: 1, signalCounterThreshold: 3, signalCounterMin: 3, priceUpThrPct: 0.7, oiUpThrPct: 70, oiCandleThrPct: 0.4, maxActiveSymbols: 2, maxSpreadBps: 35, maxTickStalenessMs: 2200, minNotionalUSDT: 12, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  conservative_3m: { ...DEFAULT_PROFILE_CONFIG, tf: 3, signalCounterThreshold: 3, signalCounterMin: 3, priceUpThrPct: 0.8, oiUpThrPct: 80, oiCandleThrPct: 0.5, maxActiveSymbols: 2, maxSpreadBps: 32, maxTickStalenessMs: 2000, minNotionalUSDT: 14, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  conservative_5m: { ...DEFAULT_PROFILE_CONFIG, tf: 5, signalCounterThreshold: 3, signalCounterMin: 3, priceUpThrPct: 0.9, oiUpThrPct: 90, oiCandleThrPct: 0.6, maxActiveSymbols: 2, maxSpreadBps: 30, maxTickStalenessMs: 2000, minNotionalUSDT: 16, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' },
  skip_most_trades: { ...DEFAULT_PROFILE_CONFIG, tf: 5, signalCounterThreshold: 5, signalCounterMin: 5, signalCounterMax: Number.MAX_SAFE_INTEGER, priceUpThrPct: 4.5, oiUpThrPct: 280, oiCandleThrPct: 20, maxActiveSymbols: 1, maxSpreadBps: 12, maxTickStalenessMs: 900, minNotionalUSDT: 100, autoTuneEnabled: true, autoTuneScope: 'GLOBAL' }
};

const DEFAULT_PROFILES_FILE: ProfilesFile = {
  activeProfile: DEFAULT_PROFILE_NAME,
  profiles: {
    [DEFAULT_PROFILE_NAME]: DEFAULT_PROFILE_CONFIG,
    ...SHIPPED_PRESETS
  }
};

export class ProfileService {
  private state: ProfilesFile | null = null;

  constructor(private readonly filePath = path.resolve(process.cwd(), 'data/profiles.json')) {}

  async list(): Promise<{ activeProfile: string; names: string[] }> {
    const state = await this.ensureLoaded();
    return {
      activeProfile: state.activeProfile,
      names: Object.keys(state.profiles).sort((a, b) => a.localeCompare(b))
    };
  }

  async get(name: string): Promise<BotConfig | null> {
    const state = await this.ensureLoaded();
    return state.profiles[name] ?? null;
  }

  async set(name: string, config: BotConfig): Promise<void> {
    const state = await this.ensureLoaded();
    state.profiles[name] = config;
    await this.persist(state);
  }

  async setActive(name: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (!state.profiles[name]) {
      throw new Error('NOT_FOUND');
    }

    state.activeProfile = name;
    await this.persist(state);
  }

  async delete(name: string): Promise<void> {
    const state = await this.ensureLoaded();
    if (name === DEFAULT_PROFILE_NAME) {
      throw new Error('DEFAULT_PROFILE_LOCKED');
    }

    if (!state.profiles[name]) {
      throw new Error('NOT_FOUND');
    }

    delete state.profiles[name];

    if (state.activeProfile === name) {
      state.activeProfile = DEFAULT_PROFILE_NAME;
    }

    await this.persist(state);
  }

  async export(): Promise<ProfilesFile> {
    const state = await this.ensureLoaded();
    return {
      activeProfile: state.activeProfile,
      profiles: { ...state.profiles }
    };
  }

  async import(raw: unknown): Promise<void> {
    const state = await this.ensureLoaded();
    if (!raw || typeof raw !== 'object') {
      throw new Error('INVALID_IMPORT');
    }

    const input = raw as { activeProfile?: unknown; profiles?: unknown };
    if (!input.profiles || typeof input.profiles !== 'object' || Array.isArray(input.profiles)) {
      throw new Error('INVALID_IMPORT');
    }

    const importedProfiles = input.profiles as Record<string, unknown>;
    for (const [name, config] of Object.entries(importedProfiles)) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        continue;
      }

      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        continue;
      }

      const normalized = normalizeBotConfig(config as Record<string, unknown>);
      if (normalized) {
        state.profiles[name] = normalized;
      }
    }

    if (typeof input.activeProfile === 'string' && state.profiles[input.activeProfile]) {
      state.activeProfile = input.activeProfile;
    }

    if (!state.profiles[DEFAULT_PROFILE_NAME]) {
      state.profiles[DEFAULT_PROFILE_NAME] = DEFAULT_PROFILE_CONFIG;
    }

    this.seedStarterProfiles(state);

    await this.persist(state);
  }

  private async ensureLoaded(): Promise<ProfilesFile> {
    if (this.state) {
      return this.state;
    }

    this.state = await this.loadFromDisk();
    return this.state;
  }

  private async loadFromDisk(): Promise<ProfilesFile> {
    try {
      await access(this.filePath);
    } catch {
      await this.persist(DEFAULT_PROFILES_FILE);
      return {
        activeProfile: DEFAULT_PROFILES_FILE.activeProfile,
        profiles: { ...DEFAULT_PROFILES_FILE.profiles }
      };
    }

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as { activeProfile?: unknown; profiles?: unknown };
      if (!parsed || typeof parsed !== 'object' || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
        throw new Error('INVALID_FILE');
      }

      const profiles: Record<string, BotConfig> = {};
      for (const [name, config] of Object.entries(parsed.profiles as Record<string, unknown>)) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          continue;
        }

        const normalized = normalizeBotConfig(config as Record<string, unknown>);
        if (normalized) {
          profiles[name] = normalized;
        }
      }

      if (!profiles[DEFAULT_PROFILE_NAME]) {
        profiles[DEFAULT_PROFILE_NAME] = DEFAULT_PROFILE_CONFIG;
      }

      this.seedStarterProfiles({ activeProfile: DEFAULT_PROFILE_NAME, profiles });

      const activeProfile =
        typeof parsed.activeProfile === 'string' && profiles[parsed.activeProfile] ? parsed.activeProfile : DEFAULT_PROFILE_NAME;

      const next = { activeProfile, profiles };
      await this.persist(next);
      return next;
    } catch {
      await this.persist(DEFAULT_PROFILES_FILE);
      return {
        activeProfile: DEFAULT_PROFILES_FILE.activeProfile,
        profiles: { ...DEFAULT_PROFILES_FILE.profiles }
      };
    }
  }

  private async persist(state: ProfilesFile): Promise<void> {
    this.state = {
      activeProfile: state.activeProfile,
      profiles: { ...state.profiles }
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  private seedStarterProfiles(state: ProfilesFile): void {
    for (const legacyName of LEGACY_SHIPPED_PRESETS) {
      delete state.profiles[legacyName];
    }

    for (const presetName of SHIPPED_PRESET_NAMES) {
      if (!state.profiles[presetName]) {
        state.profiles[presetName] = SHIPPED_PRESETS[presetName];
      }
    }
  }
}

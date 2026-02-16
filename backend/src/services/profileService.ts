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
  tf: 1,
  holdSeconds: 3,
  priceUpThrPct: 0.5,
  oiUpThrPct: 50,
  marginUSDT: 100,
  leverage: 10,
  tpRoiPct: 1,
  slRoiPct: 0.7
};

const DEFAULT_PROFILES_FILE: ProfilesFile = {
  activeProfile: DEFAULT_PROFILE_NAME,
  profiles: {
    [DEFAULT_PROFILE_NAME]: DEFAULT_PROFILE_CONFIG
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
}


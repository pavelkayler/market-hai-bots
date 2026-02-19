import path from 'node:path';

export type StoragePaths = {
  universePath: string;
  runtimePath: string;
  journalPath: string;
};

export const resolveStoragePaths = (overrides: Partial<StoragePaths> = {}): StoragePaths => ({
  universePath: overrides.universePath ?? path.resolve(process.cwd(), 'data/universe.json'),
  runtimePath: overrides.runtimePath ?? path.resolve(process.cwd(), 'data/runtime.json'),
  journalPath: overrides.journalPath ?? path.resolve(process.cwd(), 'data/journal.ndjson')
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, '../../..');
const legacyDataDir = path.resolve(backendRoot, 'backend/data');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(backendRoot, 'data');

export function ensureDataDir({ logger = console } = {}) {
  migrateLegacyDataDir({ logger });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

function migrateLegacyDataDir({ logger = console } = {}) {
  if (legacyDataDir === DATA_DIR) return;
  if (!fs.existsSync(legacyDataDir)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const files = fs.readdirSync(legacyDataDir);
  for (const name of files) {
    const from = path.join(legacyDataDir, name);
    const to = path.join(DATA_DIR, name);
    if (fs.existsSync(to)) continue;
    fs.renameSync(from, to);
  }
  const left = fs.readdirSync(legacyDataDir);
  if (left.length === 0) {
    fs.rmdirSync(legacyDataDir);
  }
  logger?.info?.({ legacyDataDir, DATA_DIR, moved: files.length, remaining: left.length }, 'migrated legacy backend/backend/data files');
}

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

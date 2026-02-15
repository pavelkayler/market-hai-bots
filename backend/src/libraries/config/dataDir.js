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
  fs.mkdirSync(DATA_DIR, { recursive: true });
  migrateLegacyDataDir({ logger });
  return DATA_DIR;
}

function migrateLegacyDataDir({ logger = console } = {}) {
  if (legacyDataDir === DATA_DIR) return;
  if (!fs.existsSync(legacyDataDir)) return;
  const files = fs.readdirSync(legacyDataDir);
  if (!files.length) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of files) {
    const from = path.join(legacyDataDir, name);
    const to = path.join(DATA_DIR, name);
    if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to);
    }
  }
  logger?.info?.({ legacyDataDir, DATA_DIR, files: files.length }, 'migrated legacy backend/backend/data files');
}

export function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';

export function createMomentumSqlite({ dbPath = 'backend/data/momentum.sqlite', logger = console } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new sqlite3.Database(dbPath);
  const queue = [];
  let busy = false;

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
  function all(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
  }

  async function ensureColumn(table, column, typeAndDefault) {
    const cols = await all(`PRAGMA table_info(${table})`);
    const hasColumn = (cols || []).some((c) => String(c?.name || '').toLowerCase() === String(column).toLowerCase());
    if (!hasColumn) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeAndDefault}`);
  }

  async function init() {
    await run(`CREATE TABLE IF NOT EXISTS momentum_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instanceId TEXT, mode TEXT, symbol TEXT, side TEXT,
      windowMinutes INTEGER, priceThresholdPct REAL, oiThresholdPct REAL,
      turnover24hMin REAL, vol24hMin REAL, leverage REAL, marginUsd REAL,
      entryTs INTEGER, entryPrice REAL, exitTs INTEGER, exitPrice REAL,
      outcome TEXT, pnlUsd REAL, feesUsd REAL, durationSec INTEGER,
      entryOffsetPct REAL DEFAULT 0
    )`);
    await run(`CREATE TABLE IF NOT EXISTS momentum_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instanceId TEXT, symbol TEXT, side TEXT, ts INTEGER,
      windowMinutes INTEGER, priceChange REAL, oiChange REAL,
      markNow REAL, markPrev REAL, oiNow REAL, oiPrev REAL,
      turnover24h REAL, vol24h REAL, action TEXT,
      entryOffsetPct REAL DEFAULT 0
    )`);
    await ensureColumn('momentum_trades', 'entryOffsetPct', 'REAL DEFAULT 0');
    await ensureColumn('momentum_signals', 'entryOffsetPct', 'REAL DEFAULT 0');
    await run('CREATE INDEX IF NOT EXISTS idx_momentum_trades_instance_entry ON momentum_trades(instanceId, entryTs)');
    await run('CREATE INDEX IF NOT EXISTS idx_momentum_trades_symbol_entry ON momentum_trades(symbol, entryTs)');
  }

  function enqueueWrite(task) {
    queue.push(task);
    if (busy) return;
    busy = true;
    const loop = async () => {
      const next = queue.shift();
      if (!next) {
        busy = false;
        return;
      }
      try { await next(); } catch (err) { logger.warn?.({ err }, 'momentum sqlite write failed'); }
      setImmediate(loop);
    };
    setImmediate(loop);
  }

  function saveSignal(row) {
    enqueueWrite(() => run(`INSERT INTO momentum_signals(instanceId, symbol, side, ts, windowMinutes, priceChange, oiChange, markNow, markPrev, oiNow, oiPrev, turnover24h, vol24h, action, entryOffsetPct)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.instanceId, row.symbol, row.side, row.ts, row.windowMinutes, row.priceChange, row.oiChange, row.markNow, row.markPrev, row.oiNow, row.oiPrev, row.turnover24h, row.vol24h, row.action, row.entryOffsetPct ?? 0]));
  }

  function saveTrade(row) {
    enqueueWrite(() => run(`INSERT INTO momentum_trades(instanceId, mode, symbol, side, windowMinutes, priceThresholdPct, oiThresholdPct, turnover24hMin, vol24hMin, leverage, marginUsd, entryTs, entryPrice, exitTs, exitPrice, outcome, pnlUsd, feesUsd, durationSec, entryOffsetPct)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.instanceId, row.mode, row.symbol, row.side, row.windowMinutes, row.priceThresholdPct, row.oiThresholdPct, row.turnover24hMin, row.vol24hMin, row.leverage, row.marginUsd, row.entryTs, row.entryPrice, row.exitTs, row.exitPrice, row.outcome, row.pnlUsd, row.feesUsd, row.durationSec, row.entryOffsetPct ?? 0]));
  }

  async function getTrades(instanceId, limit = 50, offset = 0) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = await all('SELECT * FROM momentum_trades WHERE instanceId=? ORDER BY entryTs DESC LIMIT ? OFFSET ?', [instanceId, lim, off]);
    const totalRows = await all('SELECT COUNT(*) as c FROM momentum_trades WHERE instanceId=?', [instanceId]);
    return { trades: rows, total: Number(totalRows?.[0]?.c || 0) };
  }

  return { init, saveSignal, saveTrade, getTrades };
}

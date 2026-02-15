import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { dataPath, ensureDataDir } from '../../libraries/config/dataDir.js';

export function createMomentumSqlite({ dbPath = dataPath('momentum.sqlite'), logger = console } = {}) {
  ensureDataDir({ logger });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const queue = [];
  let busy = false;

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        const info = stmt.run(params);
        resolve({ lastID: Number(info?.lastInsertRowid || 0), changes: Number(info?.changes || 0) });
      } catch (err) {
        reject(err);
      }
    });
  }

  function all(sql, params = []) {
    return new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(sql);
        resolve(stmt.all(params) || []);
      } catch (err) {
        reject(err);
      }
    });
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
      entryTs INTEGER, triggerPrice REAL, entryPrice REAL, actualEntryPrice REAL, exitTs INTEGER, exitPrice REAL,
      outcome TEXT, pnlUsd REAL, feesUsd REAL, durationSec INTEGER,
      entryOffsetPct REAL DEFAULT 0, turnoverSpikePct REAL DEFAULT 100,
      baselineFloorUSDT REAL DEFAULT 100000, holdSeconds INTEGER DEFAULT 3,
      trendConfirmSeconds INTEGER DEFAULT 3, oiMaxAgeSec REAL DEFAULT 10,
      lastPriceAtTrigger REAL, markPriceAtTrigger REAL,
      entryOrderId TEXT, entryPriceActual REAL, entryQtyActual REAL, entryFillTs INTEGER,
      tpPrice REAL, slPrice REAL, tpSlStatus TEXT, tpOrderId TEXT, slOrderId TEXT
    )`);
    await run(`CREATE TABLE IF NOT EXISTS momentum_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instanceId TEXT, symbol TEXT, side TEXT, ts INTEGER,
      windowMinutes INTEGER, priceChange REAL, oiChange REAL,
      markNow REAL, markPrev REAL, lastNow REAL, lastPrev REAL, oiNow REAL, oiPrev REAL,
      turnover24h REAL, vol24h REAL, action TEXT,
      entryOffsetPct REAL DEFAULT 0,
      prevTurnoverUSDT REAL, medianTurnoverUSDT REAL, curTurnoverUSDT REAL, turnoverBaselineUSDT REAL, turnoverGatePassed INTEGER, turnoverSpikePct REAL DEFAULT 100,
      baselineFloorUSDT REAL DEFAULT 100000, holdSeconds INTEGER DEFAULT 3,
      trendConfirmSeconds INTEGER DEFAULT 3, oiMaxAgeSec REAL DEFAULT 10, oiAgeSec REAL
    )`);
    await ensureColumn('momentum_trades', 'entryOffsetPct', 'REAL DEFAULT 0');
    await ensureColumn('momentum_trades', 'turnoverSpikePct', 'REAL DEFAULT 100');
    await ensureColumn('momentum_trades', 'triggerPrice', 'REAL');
    await ensureColumn('momentum_trades', 'actualEntryPrice', 'REAL');
    await ensureColumn('momentum_trades', 'baselineFloorUSDT', 'REAL DEFAULT 100000');
    await ensureColumn('momentum_trades', 'holdSeconds', 'INTEGER DEFAULT 3');
    await ensureColumn('momentum_trades', 'trendConfirmSeconds', 'INTEGER DEFAULT 3');
    await ensureColumn('momentum_trades', 'oiMaxAgeSec', 'REAL DEFAULT 10');
    await ensureColumn('momentum_trades', 'lastPriceAtTrigger', 'REAL');
    await ensureColumn('momentum_trades', 'markPriceAtTrigger', 'REAL');
    await ensureColumn('momentum_trades', 'entryOrderId', 'TEXT');
    await ensureColumn('momentum_trades', 'entryPriceActual', 'REAL');
    await ensureColumn('momentum_trades', 'entryQtyActual', 'REAL');
    await ensureColumn('momentum_trades', 'entryFillTs', 'INTEGER');
    await ensureColumn('momentum_trades', 'tpPrice', 'REAL');
    await ensureColumn('momentum_trades', 'slPrice', 'REAL');
    await ensureColumn('momentum_trades', 'tpSlStatus', 'TEXT');
    await ensureColumn('momentum_trades', 'tpOrderId', 'TEXT');
    await ensureColumn('momentum_trades', 'slOrderId', 'TEXT');

    await ensureColumn('momentum_signals', 'entryOffsetPct', 'REAL DEFAULT 0');
    await ensureColumn('momentum_signals', 'prevTurnoverUSDT', 'REAL');
    await ensureColumn('momentum_signals', 'medianTurnoverUSDT', 'REAL');
    await ensureColumn('momentum_signals', 'curTurnoverUSDT', 'REAL');
    await ensureColumn('momentum_signals', 'turnoverBaselineUSDT', 'REAL');
    await ensureColumn('momentum_signals', 'turnoverGatePassed', 'INTEGER');
    await ensureColumn('momentum_signals', 'turnoverSpikePct', 'REAL DEFAULT 100');
    await ensureColumn('momentum_signals', 'baselineFloorUSDT', 'REAL DEFAULT 100000');
    await ensureColumn('momentum_signals', 'holdSeconds', 'INTEGER DEFAULT 3');
    await ensureColumn('momentum_signals', 'trendConfirmSeconds', 'INTEGER DEFAULT 3');
    await ensureColumn('momentum_signals', 'oiMaxAgeSec', 'REAL DEFAULT 10');
    await ensureColumn('momentum_signals', 'lastNow', 'REAL');
    await ensureColumn('momentum_signals', 'lastPrev', 'REAL');
    await ensureColumn('momentum_signals', 'oiAgeSec', 'REAL');
    await run('CREATE INDEX IF NOT EXISTS idx_momentum_trades_instance_entry ON momentum_trades(instanceId, entryTs)');
    await run('CREATE INDEX IF NOT EXISTS idx_momentum_trades_symbol_entry ON momentum_trades(symbol, entryTs)');
    await ensureColumn('momentum_trades', 'qty', 'REAL');
    await ensureColumn('momentum_trades', 'pnlGross', 'REAL');
    await ensureColumn('momentum_trades', 'pnlNet', 'REAL');
    await ensureColumn('momentum_trades', 'feeEntry', 'REAL');
    await ensureColumn('momentum_trades', 'feeExit', 'REAL');
    await ensureColumn('momentum_trades', 'makerFeeRate', 'REAL');
    await ensureColumn('momentum_trades', 'takerFeeRate', 'REAL');

    await run(`CREATE TABLE IF NOT EXISTS momentum_instances (
      instanceId TEXT PRIMARY KEY,
      createdAtMs INTEGER,
      updatedAtMs INTEGER,
      configJson TEXT NOT NULL,
      lastSnapshotJson TEXT,
      wasRunning INTEGER DEFAULT 0,
      lastStoppedAtMs INTEGER
    )`);

    await run(`CREATE TABLE IF NOT EXISTS momentum_fixed_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tsMs INTEGER,
      instanceId TEXT,
      symbol TEXT,
      side TEXT,
      windowMinutes INTEGER,
      action TEXT,
      reason TEXT,
      metricsJson TEXT NOT NULL
    )`);
    await run('CREATE INDEX IF NOT EXISTS idx_momentum_fixed_signals_instance_ts ON momentum_fixed_signals(instanceId, tsMs DESC)');
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
    enqueueWrite(() => run(`INSERT INTO momentum_signals(instanceId, symbol, side, ts, windowMinutes, priceChange, oiChange, markNow, markPrev, lastNow, lastPrev, oiNow, oiPrev, turnover24h, vol24h, action, entryOffsetPct, prevTurnoverUSDT, medianTurnoverUSDT, curTurnoverUSDT, turnoverBaselineUSDT, turnoverGatePassed, turnoverSpikePct, baselineFloorUSDT, holdSeconds, trendConfirmSeconds, oiMaxAgeSec, oiAgeSec)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.instanceId, row.symbol, row.side, row.ts, row.windowMinutes, row.priceChange, row.oiChange, row.markNow, row.markPrev, row.lastNow, row.lastPrev, row.oiNow, row.oiPrev, row.turnover24h, row.vol24h, row.action, row.entryOffsetPct ?? 0, row.prevTurnoverUSDT ?? null, row.medianTurnoverUSDT ?? null, row.curTurnoverUSDT ?? null, row.turnoverBaselineUSDT ?? null, row.turnoverGatePassed ?? null, row.turnoverSpikePct ?? 100, row.baselineFloorUSDT ?? 100000, row.holdSeconds ?? 3, row.trendConfirmSeconds ?? 3, row.oiMaxAgeSec ?? 10, row.oiAgeSec ?? null]));
  }

  function saveTrade(row) {
    enqueueWrite(() => run(`INSERT INTO momentum_trades(instanceId, mode, symbol, side, windowMinutes, priceThresholdPct, oiThresholdPct, turnover24hMin, vol24hMin, leverage, marginUsd, entryTs, triggerPrice, entryPrice, actualEntryPrice, exitTs, exitPrice, outcome, pnlUsd, feesUsd, durationSec, entryOffsetPct, turnoverSpikePct, baselineFloorUSDT, holdSeconds, trendConfirmSeconds, oiMaxAgeSec, lastPriceAtTrigger, markPriceAtTrigger, entryOrderId, entryPriceActual, entryQtyActual, entryFillTs, tpPrice, slPrice, tpSlStatus, tpOrderId, slOrderId, qty, pnlGross, pnlNet, feeEntry, feeExit, makerFeeRate, takerFeeRate)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.instanceId, row.mode, row.symbol, row.side, row.windowMinutes, row.priceThresholdPct, row.oiThresholdPct, row.turnover24hMin, row.vol24hMin, row.leverage, row.marginUsd, row.entryTs, row.triggerPrice ?? null, row.entryPrice, row.actualEntryPrice ?? null, row.exitTs, row.exitPrice, row.outcome, row.pnlUsd, row.feesUsd, row.durationSec, row.entryOffsetPct ?? 0, row.turnoverSpikePct ?? 100, row.baselineFloorUSDT ?? 100000, row.holdSeconds ?? 3, row.trendConfirmSeconds ?? 3, row.oiMaxAgeSec ?? 10, row.lastPriceAtTrigger ?? null, row.markPriceAtTrigger ?? null, row.entryOrderId ?? null, row.entryPriceActual ?? null, row.entryQtyActual ?? null, row.entryFillTs ?? null, row.tpPrice ?? null, row.slPrice ?? null, row.tpSlStatus ?? null, row.tpOrderId ?? null, row.slOrderId ?? null, row.qty ?? null, row.pnlGross ?? null, row.pnlNet ?? null, row.feeEntry ?? null, row.feeExit ?? null, row.makerFeeRate ?? null, row.takerFeeRate ?? null]));
  }



  function saveInstance(row) {
    enqueueWrite(() => run(`INSERT INTO momentum_instances(instanceId, createdAtMs, updatedAtMs, configJson, lastSnapshotJson, wasRunning, lastStoppedAtMs)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(instanceId) DO UPDATE SET updatedAtMs=excluded.updatedAtMs, configJson=excluded.configJson, lastSnapshotJson=excluded.lastSnapshotJson, wasRunning=excluded.wasRunning, lastStoppedAtMs=excluded.lastStoppedAtMs`,
    [row.instanceId, row.createdAtMs, row.updatedAtMs, row.configJson, row.lastSnapshotJson ?? null, row.wasRunning ? 1 : 0, row.lastStoppedAtMs ?? null]));
  }

  async function getInstances() {
    return all('SELECT * FROM momentum_instances ORDER BY createdAtMs ASC');
  }

  function saveFixedSignal(row) {
    enqueueWrite(() => run(`INSERT INTO momentum_fixed_signals(tsMs, instanceId, symbol, side, windowMinutes, action, reason, metricsJson) VALUES(?,?,?,?,?,?,?,?)`, [row.tsMs, row.instanceId, row.symbol, row.side, row.windowMinutes, row.action, row.reason ?? null, JSON.stringify(row.metrics || {})]));
  }

  async function getFixedSignals({ instanceId, limit = 100, sinceMs = 0, symbol = null } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const params = [instanceId, Number(sinceMs) || 0];
    let sql = 'SELECT * FROM momentum_fixed_signals WHERE instanceId=? AND tsMs>=?';
    if (symbol) { sql += ' AND symbol=?'; params.push(String(symbol).toUpperCase()); }
    sql += ' ORDER BY tsMs DESC LIMIT ?'; params.push(lim);
    const rows = await all(sql, params);
    return rows.map((r) => ({ ...r, metrics: JSON.parse(r.metricsJson || '{}') }));
  }


  async function updateInstanceConfig({ instanceId, config, updatedAtMs = Date.now() } = {}) {
    if (!instanceId) return { changes: 0 };
    return run('UPDATE momentum_instances SET configJson=?, updatedAtMs=? WHERE instanceId=?', [JSON.stringify(config || {}), Number(updatedAtMs) || Date.now(), String(instanceId)]);
  }

  async function deleteInstance(instanceId) {
    const id = String(instanceId || '');
    if (!id) return { ok: false, reason: 'INSTANCE_ID_REQUIRED' };
    await run('DELETE FROM momentum_instances WHERE instanceId=?', [id]);
    await run('DELETE FROM momentum_trades WHERE instanceId=?', [id]);
    await run('DELETE FROM momentum_fixed_signals WHERE instanceId=?', [id]);
    await run('DELETE FROM momentum_signals WHERE instanceId=?', [id]);
    return { ok: true };
  }

  async function getSignals(instanceId, limit = 100) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = await all('SELECT * FROM momentum_signals WHERE instanceId=? ORDER BY ts DESC LIMIT ?', [instanceId, lim]);
    return rows;
  }

  async function getTrades(instanceId, limit = 50, offset = 0) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const rows = await all('SELECT * FROM momentum_trades WHERE instanceId=? ORDER BY entryTs DESC LIMIT ? OFFSET ?', [instanceId, lim, off]);
    const totalRows = await all('SELECT COUNT(*) as c FROM momentum_trades WHERE instanceId=?', [instanceId]);
    return { trades: rows, total: Number(totalRows?.[0]?.c || 0) };
  }

  return { init, saveSignal, saveTrade, getTrades, getSignals, saveInstance, getInstances, updateInstanceConfig, deleteInstance, saveFixedSignal, getFixedSignals };
}

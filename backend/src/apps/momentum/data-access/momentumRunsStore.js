import Database from 'better-sqlite3';
import { dataPath, ensureDataDir } from '../../../libraries/config/dataDir.js';

export function createMomentumRunsStore({ dbPath = dataPath('momentum.sqlite') } = {}) {
  ensureDataDir();
  const db = new Database(dbPath);

  db.exec(`CREATE TABLE IF NOT EXISTS bot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    botId TEXT NOT NULL,
    runId TEXT NOT NULL,
    startedAt INTEGER NOT NULL,
    stoppedAt INTEGER,
    mode TEXT,
    summaryJson TEXT,
    UNIQUE(botId, runId)
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bot_runs_bot_started ON bot_runs(botId, startedAt DESC)');

  function startRun({ botId, mode }) {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare('INSERT INTO bot_runs(botId, runId, startedAt, mode, summaryJson) VALUES(?,?,?,?,?)')
      .run(botId, runId, Date.now(), mode || null, JSON.stringify({}));
    return { runId };
  }

  function stopActiveRun({ botId, summary = {} }) {
    const row = db.prepare('SELECT runId FROM bot_runs WHERE botId=? AND stoppedAt IS NULL ORDER BY startedAt DESC LIMIT 1').get(botId);
    if (!row?.runId) return { ok: false };
    db.prepare('UPDATE bot_runs SET stoppedAt=?, summaryJson=? WHERE botId=? AND runId=?')
      .run(Date.now(), JSON.stringify(summary || {}), botId, row.runId);
    return { ok: true, runId: row.runId };
  }

  function listRuns(botId) {
    return db.prepare('SELECT * FROM bot_runs WHERE botId=? ORDER BY startedAt DESC').all(botId);
  }

  function listTrades(botId) {
    return db.prepare('SELECT * FROM momentum_trades WHERE instanceId=? ORDER BY entryTs DESC').all(botId);
  }

  function deleteBot(botId) {
    db.prepare('DELETE FROM bot_runs WHERE botId=?').run(botId);
  }

  function getStats(botId) {
    const runs = listRuns(botId).map((run) => {
      const trades = db.prepare('SELECT * FROM momentum_trades WHERE instanceId=? AND entryTs>=? AND (? IS NULL OR entryTs<=?) ORDER BY entryTs DESC')
        .all(botId, Number(run.startedAt || 0), run.stoppedAt ?? null, run.stoppedAt ?? null);
      const pnl = trades.reduce((sum, t) => sum + Number(t.pnlNet ?? t.pnlUsd ?? 0), 0);
      const wins = trades.filter((t) => Number(t.pnlNet ?? t.pnlUsd ?? 0) >= 0).length;
      return {
        runId: run.runId,
        startedAt: run.startedAt,
        stoppedAt: run.stoppedAt,
        mode: run.mode,
        tradesCount: trades.length,
        winrate: trades.length ? (wins * 100) / trades.length : 0,
        pnl,
      };
    });
    const trades = listTrades(botId).map((t) => ({ ...t, runId: runs.find((r) => Number(t.entryTs) >= Number(r.startedAt) && (!r.stoppedAt || Number(t.entryTs) <= Number(r.stoppedAt)))?.runId || null }));
    return { botId, runs, trades };
  }

  return { startRun, stopActiveRun, listRuns, listTrades, deleteBot, getStats };
}

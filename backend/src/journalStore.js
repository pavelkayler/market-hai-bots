import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATH = path.resolve(process.cwd(), 'backend/data/journal.jsonl');

function toOutcome(pnl) {
  if (pnl > 0) return 'WIN';
  if (pnl < 0) return 'LOSS';
  return 'BREAKEVEN';
}

export function createJournalStore({ filePath = DEFAULT_PATH, logger = console, maxInMemory = 200 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let rows = [];

  function append(record) {
    const row = {
      id: record?.id || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      botName: record?.botName || 'Unknown',
      symbol: record?.symbol || '',
      side: record?.side || '',
      mode: record?.mode || 'paper',
      openedAt: Number(record?.openedAt || Date.now()),
      closedAt: Number(record?.closedAt || Date.now()),
      entryPrice: Number(record?.entryPrice || 0),
      exitPrice: Number(record?.exitPrice || 0),
      tpLevels: Array.isArray(record?.tpLevels) ? record.tpLevels : [],
      slLevel: Number(record?.slLevel || 0),
      qty: Number(record?.qty || 0),
      notionalUsd: Number(record?.notionalUsd || 0),
      leverage: Number(record?.leverage || 1),
      pnlUsdt: Number(record?.pnlUsdt || 0),
      roiPct: Number(record?.roiPct || 0),
      outcome: record?.outcome || toOutcome(Number(record?.pnlUsdt || 0)),
      reasonOpen: record?.reasonOpen || '',
      reasonClose: record?.reasonClose || '',
      snapshot: record?.snapshot || {},
    };
    rows.unshift(row);
    rows = rows.slice(0, maxInMemory);
    try {
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
    } catch (e) {
      logger?.warn?.({ err: e }, 'journal append failed');
    }
    return row;
  }

  function list({ botName, mode, limit = 200 } = {}) {
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    return rows
      .filter((x) => (!botName || x.botName === botName) && (!mode || x.mode === mode))
      .slice(0, lim);
  }

  function getAggregates() {
    const byBot = {};
    for (const row of rows) {
      const key = row.botName;
      if (!byBot[key]) byBot[key] = { pnlUsdt: 0, wins: 0, losses: 0, breakeven: 0, trades: 0 };
      byBot[key].pnlUsdt += Number(row.pnlUsdt || 0);
      byBot[key].trades += 1;
      if (row.outcome === 'WIN') byBot[key].wins += 1;
      else if (row.outcome === 'LOSS') byBot[key].losses += 1;
      else byBot[key].breakeven += 1;
    }
    return byBot;
  }

  return { append, list, getAggregates };
}

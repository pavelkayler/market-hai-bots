function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundPct(value) {
  return Math.round(value * 1000000) / 1000000;
}

function buildConfigKey(settings = {}) {
  return [
    String(settings.leaderSymbol || '').toUpperCase(),
    String(settings.followerSymbol || '').toUpperCase(),
    roundPct(safeNum(settings.leaderMovePct, 0)),
    roundPct(safeNum(settings.followerTpPct, 0)),
    roundPct(safeNum(settings.followerSlPct, 0)),
    Math.max(0, Math.trunc(safeNum(settings.lagMs, 0))),
    settings.allowShort !== false ? 1 : 0,
    100,
    10,
  ].join('|');
}

function summarizeConfig(settings = {}) {
  return `${String(settings.leaderSymbol || '').toUpperCase()}/${String(settings.followerSymbol || '').toUpperCase()} trg:${safeNum(settings.leaderMovePct, 0)} tp:${safeNum(settings.followerTpPct, 0)} sl:${safeNum(settings.followerSlPct, 0)} lag:${Math.max(0, Math.trunc(safeNum(settings.lagMs, 0)))} short:${settings.allowShort !== false ? 'y' : 'n'} size:$100x10`;
}

function computeWindowMetrics(trades = []) {
  const windowTrades = Array.isArray(trades) ? trades : [];
  const result = {
    trades: windowTrades.length,
    wins: 0,
    losses: 0,
    sumWins: 0,
    sumLossesAbs: 0,
    totalPnL: 0,
    profitFactor: Infinity,
    expectancy: 0,
    avgWin: 0,
    avgLossAbs: 0,
    feesTotal: 0,
    fundingTotal: 0,
    slippageTotal: 0,
  };

  for (const t of windowTrades) {
    const pnl = safeNum(t?.pnlUSDT, 0) || 0;
    const fees = safeNum(t?.feesUSDT, 0) || 0;
    const funding = safeNum(t?.fundingUSDT, 0) || 0;
    const slippage = safeNum(t?.slippageUSDT, 0) || 0;
    result.totalPnL += pnl;
    result.feesTotal += fees;
    result.fundingTotal += funding;
    result.slippageTotal += slippage;
    if (pnl > 0) {
      result.wins += 1;
      result.sumWins += pnl;
    } else if (pnl < 0) {
      result.losses += 1;
      result.sumLossesAbs += Math.abs(pnl);
    }
  }

  result.expectancy = result.trades > 0 ? result.totalPnL / result.trades : 0;
  result.profitFactor = result.sumLossesAbs === 0 ? Infinity : result.sumWins / result.sumLossesAbs;
  result.avgWin = result.wins > 0 ? result.sumWins / result.wins : 0;
  result.avgLossAbs = result.losses > 0 ? result.sumLossesAbs / result.losses : 0;
  return result;
}

export function createLeadLagAutoTune({ maxLogEntries = 200 } = {}) {
  const defaults = {
    enabled: true,
    minTradesToStart: 10,
    evalWindowTrades: 20,
    minProfitFactor: 1,
    minExpectancy: 0,
    tpStepPct: 0.05,
    tpMinPct: 0.05,
    tpMaxPct: 0.5,
    rollbackOnWorse: true,
    minDeltaPF: 0.05,
    minDeltaExpectancy: 0.0001,
    freezeOnGood: true,
    freezeAfterGoodWindows: 2,
    freezeTradesCount: 20,
  };

  const perConfig = new Map();
  const learningLog = [];

  function pushLog(entry) {
    learningLog.unshift({ ts: Date.now(), ...entry });
    if (learningLog.length > maxLogEntries) learningLog.length = maxLogEntries;
  }

  function normalizeConfig(next = {}, prev = defaults) {
    return {
      enabled: next.enabled === undefined ? prev.enabled : Boolean(next.enabled),
      minTradesToStart: Math.max(1, Math.trunc(safeNum(next.minTradesToStart, prev.minTradesToStart))),
      evalWindowTrades: Math.max(2, Math.trunc(safeNum(next.evalWindowTrades, prev.evalWindowTrades))),
      minProfitFactor: Math.max(0, safeNum(next.minProfitFactor, prev.minProfitFactor)),
      minExpectancy: safeNum(next.minExpectancy, prev.minExpectancy),
      tpStepPct: Math.max(0.0001, safeNum(next.tpStepPct, prev.tpStepPct)),
      tpMinPct: Math.max(0.0001, safeNum(next.tpMinPct, prev.tpMinPct)),
      tpMaxPct: Math.max(0.0001, safeNum(next.tpMaxPct, prev.tpMaxPct)),
      rollbackOnWorse: next.rollbackOnWorse === undefined ? prev.rollbackOnWorse : Boolean(next.rollbackOnWorse),
      minDeltaPF: Math.max(0, safeNum(next.minDeltaPF, prev.minDeltaPF)),
      minDeltaExpectancy: safeNum(next.minDeltaExpectancy, prev.minDeltaExpectancy),
      freezeOnGood: next.freezeOnGood === undefined ? prev.freezeOnGood : Boolean(next.freezeOnGood),
      freezeAfterGoodWindows: Math.max(1, Math.trunc(safeNum(next.freezeAfterGoodWindows, prev.freezeAfterGoodWindows))),
      freezeTradesCount: Math.max(1, Math.trunc(safeNum(next.freezeTradesCount, prev.freezeTradesCount))),
    };
  }

  let autoTuneConfig = normalizeConfig();

  function ensureConfig(configKey, settings = {}) {
    if (!perConfig.has(configKey)) {
      perConfig.set(configKey, {
        trades: [],
        currentTpPct: safeNum(settings?.followerTpPct, 1) || 1,
        lastTpPct: safeNum(settings?.followerTpPct, 1) || 1,
        lastEvaluation: null,
        lastDecision: 'KEEP',
        windowsEvaluatedCount: 0,
        consecutiveGoodWindows: 0,
        consecutiveBadWindows: 0,
        pendingEvaluationAfterChange: null,
        freezeRemainingTrades: 0,
      });
      pushLog({ type: 'START', configKey, configSummary: summarizeConfig(settings), reason: 'autotune state initialized' });
    }
    return perConfig.get(configKey);
  }

  function onTradeClosed({ settings = {}, trade }) {
    const configKey = buildConfigKey(settings);
    const cfg = ensureConfig(configKey, settings);
    cfg.trades.push(trade);
    if (cfg.trades.length > 500) cfg.trades = cfg.trades.slice(-500);

    const { minTradesToStart, evalWindowTrades, minProfitFactor, minExpectancy, tpStepPct, tpMinPct, tpMaxPct } = autoTuneConfig;

    if (!autoTuneConfig.enabled) {
      return { configKey, tuningStatus: 'idle', changed: false, logAdded: false };
    }

    if (cfg.trades.length < minTradesToStart || cfg.trades.length < evalWindowTrades) {
      return { configKey, tuningStatus: 'idle', changed: false, logAdded: false };
    }

    const windowTrades = cfg.trades.slice(-evalWindowTrades);
    const metrics = computeWindowMetrics(windowTrades);
    const prevEval = cfg.lastEvaluation;
    cfg.lastEvaluation = { ...metrics, ts: Date.now() };
    cfg.windowsEvaluatedCount += 1;

    const isBad = metrics.profitFactor < minProfitFactor || metrics.expectancy < minExpectancy;
    pushLog({
      type: 'EVAL',
      configKey,
      configSummary: summarizeConfig(settings),
      metrics,
      reason: isBad ? `bad window: PF<${minProfitFactor} or Exp<${minExpectancy}` : 'window meets thresholds',
    });

    if (cfg.freezeRemainingTrades > 0) {
      cfg.freezeRemainingTrades = Math.max(0, cfg.freezeRemainingTrades - 1);
      cfg.lastDecision = 'KEEP';
      return { configKey, metrics, decision: 'KEEP', tuningStatus: 'frozen', changed: false };
    }

    if (cfg.pendingEvaluationAfterChange && cfg.pendingEvaluationAfterChange.readyAtTrades <= cfg.trades.length) {
      const baseline = cfg.pendingEvaluationAfterChange.baseline;
      const improved = (metrics.profitFactor > baseline.profitFactor + autoTuneConfig.minDeltaPF)
        || (metrics.expectancy > baseline.expectancy + autoTuneConfig.minDeltaExpectancy);
      if (improved) {
        cfg.lastDecision = 'KEEP_NEW_TP';
        pushLog({ type: 'TUNE_RESULT', configKey, configSummary: summarizeConfig(settings), metrics, reason: 'improved=true' });
        cfg.pendingEvaluationAfterChange = null;
      } else if (autoTuneConfig.rollbackOnWorse) {
        const rollbackTp = cfg.lastTpPct;
        const fromTp = cfg.currentTpPct;
        cfg.currentTpPct = rollbackTp;
        cfg.pendingEvaluationAfterChange = null;
        cfg.lastDecision = 'ROLLBACK';
        pushLog({ type: 'ROLLBACK', configKey, configSummary: summarizeConfig(settings), metrics, change: { paramName: 'tpPct', from: fromTp, to: rollbackTp, step: tpStepPct }, reason: 'worse/no improvement' });
        return { configKey, metrics, decision: 'ROLLBACK', changed: true, newTpPct: rollbackTp, tpSource: 'auto', tuningStatus: 'idle' };
      }
    }

    if (!isBad) {
      cfg.consecutiveGoodWindows += 1;
      cfg.consecutiveBadWindows = 0;
      cfg.lastDecision = 'KEEP';
      if (autoTuneConfig.freezeOnGood && cfg.consecutiveGoodWindows >= autoTuneConfig.freezeAfterGoodWindows) {
        cfg.freezeRemainingTrades = autoTuneConfig.freezeTradesCount;
        pushLog({ type: 'FREEZE', configKey, configSummary: summarizeConfig(settings), metrics, reason: `good windows=${cfg.consecutiveGoodWindows}` });
      }
      return { configKey, metrics, decision: 'KEEP', changed: false, tuningStatus: cfg.freezeRemainingTrades > 0 ? 'frozen' : 'idle' };
    }

    cfg.consecutiveGoodWindows = 0;
    cfg.consecutiveBadWindows += 1;

    const currentTp = safeNum(cfg.currentTpPct, safeNum(settings?.followerTpPct, 1)) || 1;
    const newTp = clamp(roundPct(currentTp + tpStepPct), tpMinPct, tpMaxPct);
    if (newTp === currentTp) {
      cfg.lastDecision = 'KEEP';
      pushLog({ type: 'TUNE_APPLY', configKey, configSummary: summarizeConfig(settings), metrics, reason: 'tp at max, skip change', change: { paramName: 'tpPct', from: currentTp, to: newTp, step: tpStepPct } });
      return { configKey, metrics, decision: 'KEEP', changed: false, tuningStatus: 'idle' };
    }

    cfg.lastTpPct = currentTp;
    cfg.currentTpPct = newTp;
    cfg.pendingEvaluationAfterChange = {
      baseline: prevEval || metrics,
      readyAtTrades: cfg.trades.length + evalWindowTrades,
      changedAt: Date.now(),
    };
    cfg.lastDecision = 'INCREASE_TP';

    pushLog({
      type: 'TUNE_APPLY',
      configKey,
      configSummary: summarizeConfig({ ...settings, followerTpPct: newTp }),
      metrics,
      change: { paramName: 'tpPct', from: currentTp, to: newTp, step: tpStepPct },
      reason: `single-change rule: PF<${minProfitFactor} or Exp<${minExpectancy}`,
    });

    return { configKey, metrics, decision: 'INCREASE_TP', changed: true, newTpPct: newTp, tpSource: 'auto', tuningStatus: 'pending_eval' };
  }

  function setAutoTuneConfig(next = {}) {
    autoTuneConfig = normalizeConfig(next, autoTuneConfig);
    if (autoTuneConfig.tpMinPct > autoTuneConfig.tpMaxPct) {
      const swap = autoTuneConfig.tpMinPct;
      autoTuneConfig.tpMinPct = autoTuneConfig.tpMaxPct;
      autoTuneConfig.tpMaxPct = swap;
    }
    pushLog({ type: 'UNFREEZE', configKey: 'GLOBAL', reason: 'auto-tune config updated' });
    return autoTuneConfig;
  }

  function getPerConfigState(configKey) {
    const cfg = perConfig.get(configKey);
    if (!cfg) return null;
    return {
      currentTpPct: cfg.currentTpPct,
      lastTpPct: cfg.lastTpPct,
      lastEvaluation: cfg.lastEvaluation,
      lastDecision: cfg.lastDecision,
      windowsEvaluatedCount: cfg.windowsEvaluatedCount,
      consecutiveGoodWindows: cfg.consecutiveGoodWindows,
      consecutiveBadWindows: cfg.consecutiveBadWindows,
      tuningStatus: cfg.freezeRemainingTrades > 0 ? 'frozen' : (cfg.pendingEvaluationAfterChange ? 'pending_eval' : 'idle'),
      freezeRemainingTrades: cfg.freezeRemainingTrades,
    };
  }

  function clearLearningLog() {
    learningLog.length = 0;
  }

  function reset() {
    perConfig.clear();
    learningLog.length = 0;
  }

  return {
    buildConfigKey,
    onTradeClosed,
    getAutoTuneConfig: () => ({ ...autoTuneConfig }),
    setAutoTuneConfig,
    getLearningLog: () => learningLog.slice(0, maxLogEntries),
    getPerConfigState,
    clearLearningLog,
    reset,
  };
}

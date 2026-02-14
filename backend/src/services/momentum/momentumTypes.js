export const MOMENTUM_STATUS = {
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
};

export const SYMBOL_STATE = {
  IDLE: 'IDLE',
  TRIGGER_PENDING: 'TRIGGER_PENDING',
  IN_POSITION: 'IN_POSITION',
  COOLDOWN: 'COOLDOWN',
};

export const SIDE = {
  LONG: 'LONG',
  SHORT: 'SHORT',
};

export const MOMENTUM_UNIVERSE_LIMIT_OPTIONS = [50, 100, 200, 300, 500, 800, 1000];

export const DEFAULT_MOMENTUM_CONFIG = {
  mode: 'paper',
  directionMode: 'BOTH',
  windowMinutes: 1,
  universeLimit: 200,
  turnoverSpikePct: 0,
  baselineFloorUSDT: 0,
  holdSeconds: 1,
  trendConfirmSeconds: 1,
  oiMaxAgeSec: 120,
  priceThresholdPct: 0.2,
  oiThresholdPct: 0,
  turnover24hMin: 0,
  vol24hMin: 0,
  leverage: 3,
  marginUsd: 10,
  tpRoiPct: 2,
  slRoiPct: 2,
  entryOffsetPct: -0.01,
  cooldownMinutes: 60,
  globalSymbolLock: false,
  maxNewEntriesPerTick: 5,
  entryPriceSource: 'LAST',
};

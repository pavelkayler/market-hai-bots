export const MOMENTUM_STATUS = {
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
};

export const SYMBOL_STATE = {
  IDLE: 'IDLE',
  ORDER_PENDING: 'ORDER_PENDING',
  IN_POSITION: 'IN_POSITION',
  COOLDOWN: 'COOLDOWN',
};

export const SIDE = {
  LONG: 'LONG',
  SHORT: 'SHORT',
};

export const DEFAULT_MOMENTUM_CONFIG = {
  mode: 'paper',
  directionMode: 'BOTH',
  windowMinutes: 1,
  priceThresholdPct: 5,
  oiThresholdPct: 1,
  turnover24hMin: 5_000_000,
  vol24hMin: 0.1,
  leverage: 10,
  marginUsd: 100,
  tpRoiPct: 10,
  slRoiPct: 10,
  cooldownMinutes: 60,
  globalSymbolLock: false,
  maxNewEntriesPerTick: 5,
};

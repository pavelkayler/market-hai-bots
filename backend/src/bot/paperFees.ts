import { BYBIT_LINEAR_MAKER_FEE_RATE, BYBIT_LINEAR_TAKER_FEE_RATE } from '../config/fees.js';

export const PAPER_FEES = {
  makerFeeRate: BYBIT_LINEAR_MAKER_FEE_RATE,
  takerFeeRate: BYBIT_LINEAR_TAKER_FEE_RATE
} as const;

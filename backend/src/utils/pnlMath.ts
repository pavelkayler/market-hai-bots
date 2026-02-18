export type TradeSide = 'LONG' | 'SHORT';

export type PnlInputs = {
  side: TradeSide;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageUSDT?: number | null;
};

export type PnlBreakdown = {
  grossPnlUSDT: number;
  entryFeeUSDT: number;
  exitFeeUSDT: number;
  feeTotalUSDT: number;
  slippageUSDT: number;
  netPnlUSDT: number;
};

export function computePnlBreakdown(inputs: PnlInputs): PnlBreakdown {
  const grossPnlUSDT =
    inputs.side === 'LONG'
      ? (inputs.exitPrice - inputs.entryPrice) * inputs.qty
      : (inputs.entryPrice - inputs.exitPrice) * inputs.qty;
  const entryFeeUSDT = inputs.entryFeeRate * inputs.qty * inputs.entryPrice;
  const exitFeeUSDT = inputs.exitFeeRate * inputs.qty * inputs.exitPrice;
  const feeTotalUSDT = entryFeeUSDT + exitFeeUSDT;
  const slippageUSDT = inputs.slippageUSDT ?? 0;
  const netPnlUSDT = grossPnlUSDT - feeTotalUSDT - slippageUSDT;

  return {
    grossPnlUSDT,
    entryFeeUSDT,
    exitFeeUSDT,
    feeTotalUSDT,
    slippageUSDT,
    netPnlUSDT
  };
}

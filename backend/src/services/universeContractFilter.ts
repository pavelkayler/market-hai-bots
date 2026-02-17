import type { InstrumentLinear } from './bybitMarketClient.js';

export const UNIVERSE_CONTRACT_FILTER = 'USDT_LINEAR_PERPETUAL_ONLY' as const;

const normalize = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
};

export const isUsdtLinearPerpetualInstrument = (instrument: InstrumentLinear): boolean => {
  const symbol = instrument.symbol.toUpperCase();
  const category = normalize(instrument.category) ?? 'LINEAR';
  const contractType = normalize(instrument.contractType) ?? 'PERPETUAL';
  const status = normalize(instrument.status) ?? 'TRADING';
  const quoteCoin = normalize(instrument.quoteCoin);

  if (symbol.includes('-')) {
    return false;
  }

  if (category !== 'LINEAR') {
    return false;
  }

  if (contractType !== 'PERPETUAL') {
    return false;
  }

  if (status !== 'TRADING') {
    return false;
  }

  if (quoteCoin !== null) {
    return quoteCoin === 'USDT';
  }

  return symbol.endsWith('USDT');
};

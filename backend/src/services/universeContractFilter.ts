import type { InstrumentLinear } from './bybitMarketClient.js';

export const UNIVERSE_CONTRACT_FILTER = 'USDT_LINEAR_PERPETUAL_ONLY' as const;

export type UniverseContractExclusionReason = 'nonPerp' | 'expiring' | 'nonLinear' | 'nonTrading' | 'nonUSDT' | 'unknown';

const normalize = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
};

const parseDeliveryTimeToNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const contractTypeIndicatesFutures = (contractType: string | null): boolean => {
  if (!contractType) {
    return false;
  }
  return contractType.includes('FUTURES') || contractType.includes('DELIVERY');
};

const contractTypeIndicatesPerp = (contractType: string | null): boolean => {
  if (!contractType) {
    return true;
  }
  return contractType.includes('PERPETUAL');
};

const symbolLooksExpiring = (symbol: string | null): boolean => {
  if (!symbol) {
    return false;
  }
  return /-[0-9]{1,2}[A-Z]{3}[0-9]{2}$/.test(symbol);
};

export const classifyUsdtLinearPerpetualInstrument = (
  instrument: InstrumentLinear
): { included: true } | { included: false; reason: UniverseContractExclusionReason } => {
  const category = normalize(instrument.category) ?? 'LINEAR';
  const contractType = normalize(instrument.contractType);
  const status = normalize(instrument.status) ?? 'TRADING';
  const settleCoin = normalize(instrument.settleCoin);
  const quoteCoin = normalize(instrument.quoteCoin);
  const symbol = normalize(instrument.symbol);
  const deliveryTime = parseDeliveryTimeToNumber(instrument.deliveryTime);


  if (category !== 'LINEAR') {
    return { included: false, reason: 'nonLinear' };
  }

  if (settleCoin !== 'USDT' || quoteCoin !== 'USDT') {
    return settleCoin === null || quoteCoin === null ? { included: false, reason: 'unknown' } : { included: false, reason: 'nonUSDT' };
  }

  if (contractTypeIndicatesFutures(contractType) || (deliveryTime !== null && deliveryTime > 0) || symbolLooksExpiring(symbol)) {
    return { included: false, reason: 'expiring' };
  }

  if (!contractTypeIndicatesPerp(contractType)) {
    return { included: false, reason: 'nonPerp' };
  }

  if (status !== 'TRADING') {
    return { included: false, reason: 'nonTrading' };
  }

  return { included: true };
};

export const isUsdtLinearPerpetualInstrument = (instrument: InstrumentLinear): boolean => {
  return classifyUsdtLinearPerpetualInstrument(instrument).included;
};

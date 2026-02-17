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

const hasDeliveryTime = (value: string | null | undefined): boolean => {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== '0';
};

export const classifyUsdtLinearPerpetualInstrument = (
  instrument: InstrumentLinear
): { included: true } | { included: false; reason: UniverseContractExclusionReason } => {
  const category = normalize(instrument.category) ?? 'LINEAR';
  const contractType = normalize(instrument.contractType) ?? 'PERPETUAL';
  const status = normalize(instrument.status) ?? 'TRADING';
  const settleCoin = normalize(instrument.settleCoin);
  const quoteCoin = normalize(instrument.quoteCoin);


  if (category !== 'LINEAR') {
    return { included: false, reason: 'nonLinear' };
  }

  if (contractType !== 'PERPETUAL') {
    return { included: false, reason: hasDeliveryTime(instrument.deliveryTime) ? 'expiring' : 'nonPerp' };
  }

  if (hasDeliveryTime(instrument.deliveryTime)) {
    return { included: false, reason: 'expiring' };
  }

  if (status !== 'TRADING') {
    return { included: false, reason: 'nonTrading' };
  }

  if (!settleCoin && !quoteCoin) {
    const normalizedSymbol = normalize(instrument.symbol);
    if (normalizedSymbol && normalizedSymbol.endsWith('USDT')) {
      return { included: true };
    }
    return { included: false, reason: 'unknown' };
  }

  if (settleCoin !== null && settleCoin !== 'USDT') {
    return { included: false, reason: 'nonUSDT' };
  }

  if (quoteCoin !== null && quoteCoin !== 'USDT') {
    return { included: false, reason: 'nonUSDT' };
  }

  return { included: true };
};

export const isUsdtLinearPerpetualInstrument = (instrument: InstrumentLinear): boolean => {
  return classifyUsdtLinearPerpetualInstrument(instrument).included;
};

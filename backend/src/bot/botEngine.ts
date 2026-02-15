import type { MarketState } from '../market/marketHub.js';

export type BotMode = 'paper' | 'demo';
export type BotDirection = 'long' | 'short' | 'both';
export type BotTf = 1 | 3 | 5;

export type BotConfig = {
  mode: BotMode;
  direction: BotDirection;
  tf: BotTf;
  holdSeconds: number;
  priceUpThrPct: number;
  oiUpThrPct: number;
  marginUSDT: number;
  leverage: number;
  tpRoiPct: number;
  slRoiPct: number;
};

export type BotState = {
  running: boolean;
  startedAt: number | null;
  config: BotConfig | null;
  queueDepth: number;
  activeOrders: number;
  openPositions: number;
};

export type SymbolFsmState = 'IDLE' | 'HOLDING_LONG' | 'HOLDING_SHORT' | 'ENTRY_PENDING' | 'POSITION_OPEN';

export type SymbolBaseline = {
  basePrice: number;
  baseOiValue: number;
  baseTs: number;
};

export type SymbolRuntimeState = {
  symbol: string;
  fsmState: SymbolFsmState;
  baseline: SymbolBaseline | null;
  holdStartTs: number | null;
  lastEvaluationGateTs: number | null;
  blockedUntilTs: number;
  overrideGateOnce: boolean;
};

export type SignalPayload = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  markPrice: number;
  oiValue: number;
  priceDeltaPct: number;
  oiDeltaPct: number;
};

type BotEngineDeps = {
  now?: () => number;
  emitSignal: (payload: SignalPayload) => void;
};

const DEFAULT_HOLD_SECONDS = 3;
const DEFAULT_OI_UP_THR_PCT = 50;

export const normalizeBotConfig = (raw: Record<string, unknown>): BotConfig | null => {
  const tf = raw.tf;
  const mode = raw.mode;
  const direction = raw.direction;

  if (mode !== 'paper' && mode !== 'demo') {
    return null;
  }

  if (direction !== 'long' && direction !== 'short' && direction !== 'both') {
    return null;
  }

  if (tf !== 1 && tf !== 3 && tf !== 5) {
    return null;
  }

  const holdSeconds = typeof raw.holdSeconds === 'number' && Number.isFinite(raw.holdSeconds) ? raw.holdSeconds : DEFAULT_HOLD_SECONDS;
  const oiUpThrPct = typeof raw.oiUpThrPct === 'number' && Number.isFinite(raw.oiUpThrPct) ? raw.oiUpThrPct : DEFAULT_OI_UP_THR_PCT;

  const numericFields = ['priceUpThrPct', 'marginUSDT', 'leverage', 'tpRoiPct', 'slRoiPct'] as const;
  for (const key of numericFields) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      return null;
    }
  }

  return {
    mode,
    direction,
    tf,
    holdSeconds,
    priceUpThrPct: raw.priceUpThrPct as number,
    oiUpThrPct,
    marginUSDT: raw.marginUSDT as number,
    leverage: raw.leverage as number,
    tpRoiPct: raw.tpRoiPct as number,
    slRoiPct: raw.slRoiPct as number
  };
};

export class BotEngine {
  private readonly now: () => number;
  private readonly symbols = new Map<string, SymbolRuntimeState>();
  private state: BotState = {
    running: false,
    startedAt: null,
    config: null,
    queueDepth: 0,
    activeOrders: 0,
    openPositions: 0
  };

  constructor(private readonly deps: BotEngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  getState(): BotState {
    return { ...this.state };
  }

  setUniverseSymbols(symbols: string[]): void {
    const symbolSet = new Set(symbols);
    for (const symbol of this.symbols.keys()) {
      if (!symbolSet.has(symbol)) {
        this.symbols.delete(symbol);
      }
    }

    for (const symbol of symbols) {
      if (!this.symbols.has(symbol)) {
        this.symbols.set(symbol, {
          symbol,
          fsmState: 'IDLE',
          baseline: null,
          holdStartTs: null,
          lastEvaluationGateTs: null,
          blockedUntilTs: 0,
          overrideGateOnce: false
        });
      }
    }
  }

  start(config: BotConfig): void {
    this.state = {
      ...this.state,
      running: true,
      startedAt: this.now(),
      config
    };
  }

  stop(): void {
    this.state = {
      ...this.state,
      running: false
    };
  }

  getSymbolState(symbol: string): SymbolRuntimeState | undefined {
    const symbolState = this.symbols.get(symbol);
    if (!symbolState) {
      return undefined;
    }

    return {
      ...symbolState,
      baseline: symbolState.baseline ? { ...symbolState.baseline } : null
    };
  }

  onMarketUpdate(symbol: string, marketState: MarketState): void {
    if (!this.state.running || !this.state.config) {
      return;
    }

    const symbolState = this.symbols.get(symbol);
    if (!symbolState) {
      return;
    }

    if (!symbolState.baseline) {
      symbolState.baseline = {
        basePrice: marketState.markPrice,
        baseOiValue: marketState.openInterestValue,
        baseTs: marketState.ts
      };
      symbolState.fsmState = 'IDLE';
      return;
    }

    if (symbolState.fsmState === 'ENTRY_PENDING' || symbolState.fsmState === 'POSITION_OPEN') {
      return;
    }

    const now = this.now();
    const { priceDeltaPct, oiDeltaPct } = this.computeDeltas(symbolState.baseline, marketState);

    if (symbolState.fsmState === 'HOLDING_LONG') {
      const longStillTrue = this.isLongConditionTrue(priceDeltaPct, oiDeltaPct);
      if (!longStillTrue) {
        this.resetToIdle(symbolState);
        return;
      }

      if (symbolState.holdStartTs !== null && now - symbolState.holdStartTs >= this.state.config.holdSeconds * 1000) {
        this.deps.emitSignal({
          symbol,
          side: 'LONG',
          markPrice: marketState.markPrice,
          oiValue: marketState.openInterestValue,
          priceDeltaPct,
          oiDeltaPct
        });
        symbolState.blockedUntilTs = now + 1000;
        this.resetToIdle(symbolState);
      }
      return;
    }

    if (symbolState.fsmState === 'HOLDING_SHORT') {
      const shortStillTrue = this.isShortConditionTrue(priceDeltaPct, oiDeltaPct);
      if (!shortStillTrue) {
        this.resetToIdle(symbolState);
        return;
      }

      if (symbolState.holdStartTs !== null && now - symbolState.holdStartTs >= this.state.config.holdSeconds * 1000) {
        this.deps.emitSignal({
          symbol,
          side: 'SHORT',
          markPrice: marketState.markPrice,
          oiValue: marketState.openInterestValue,
          priceDeltaPct,
          oiDeltaPct
        });
        symbolState.blockedUntilTs = now + 1000;
        this.resetToIdle(symbolState);
      }
      return;
    }

    if (symbolState.blockedUntilTs > now) {
      return;
    }

    if (!this.canEvaluateAtCurrentGate(symbolState, now)) {
      return;
    }

    const side = this.getEligibleSide(priceDeltaPct, oiDeltaPct);
    if (side === 'LONG') {
      symbolState.fsmState = 'HOLDING_LONG';
      symbolState.holdStartTs = now;
    } else if (side === 'SHORT') {
      symbolState.fsmState = 'HOLDING_SHORT';
      symbolState.holdStartTs = now;
    }
  }

  private canEvaluateAtCurrentGate(symbolState: SymbolRuntimeState, now: number): boolean {
    if (symbolState.overrideGateOnce) {
      symbolState.overrideGateOnce = false;
      return true;
    }

    const boundaryTs = Math.floor(now / 60000) * 60000;
    const minute = new Date(boundaryTs).getUTCMinutes();
    if (minute % this.state.config!.tf !== 0) {
      return false;
    }

    if (symbolState.lastEvaluationGateTs === boundaryTs) {
      return false;
    }

    symbolState.lastEvaluationGateTs = boundaryTs;
    return true;
  }

  private getEligibleSide(priceDeltaPct: number, oiDeltaPct: number): 'LONG' | 'SHORT' | null {
    const direction = this.state.config!.direction;
    const longTrue = this.isLongConditionTrue(priceDeltaPct, oiDeltaPct);
    const shortTrue = this.isShortConditionTrue(priceDeltaPct, oiDeltaPct);

    if (direction === 'both') {
      if (shortTrue) {
        return 'SHORT';
      }
      if (longTrue) {
        return 'LONG';
      }
      return null;
    }

    if (direction === 'long') {
      return longTrue ? 'LONG' : null;
    }

    return shortTrue ? 'SHORT' : null;
  }

  private isLongConditionTrue(priceDeltaPct: number, oiDeltaPct: number): boolean {
    return priceDeltaPct >= this.state.config!.priceUpThrPct && oiDeltaPct >= this.state.config!.oiUpThrPct;
  }

  private isShortConditionTrue(priceDeltaPct: number, oiDeltaPct: number): boolean {
    return priceDeltaPct < 0 && oiDeltaPct < 0;
  }

  private computeDeltas(baseline: SymbolBaseline, marketState: MarketState): { priceDeltaPct: number; oiDeltaPct: number } {
    return {
      priceDeltaPct: ((marketState.markPrice - baseline.basePrice) / baseline.basePrice) * 100,
      oiDeltaPct: ((marketState.openInterestValue - baseline.baseOiValue) / baseline.baseOiValue) * 100
    };
  }

  private resetToIdle(symbolState: SymbolRuntimeState): void {
    symbolState.fsmState = 'IDLE';
    symbolState.holdStartTs = null;
  }
}

import { createManualTradeService } from '../../services/manual/manualTradeService.js';

export function createManualApp({ tradeExecutor, marketData, logger }) {
  const service = createManualTradeService({ tradeExecutor, marketData, logger });
  return { service };
}

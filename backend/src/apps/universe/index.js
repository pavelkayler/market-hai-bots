import { createUniverseSearchService } from '../../services/universeSearchService.js';

export function createUniverseApp({ marketData, subscriptions, bybitRest, logger, emitState, emitResult }) {
  const service = createUniverseSearchService({ marketData, subscriptions, bybitRest, logger, emitState, emitResult });
  return { service };
}

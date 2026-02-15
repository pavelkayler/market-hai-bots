import { createMomentumMarketData } from '../../services/momentum/momentumMarketData.js';
import { createMomentumSqlite } from '../../services/momentum/momentumSqlite.js';
import { createMomentumManager } from '../../services/momentum/momentumManager.js';

export async function createMomentumApp({ logger, tradeExecutor, getUniverseTiers }) {
  const sqlite = createMomentumSqlite({ logger });
  await sqlite.init();
  const marketData = createMomentumMarketData({ logger });
  await marketData.start();
  const manager = createMomentumManager({
    marketData,
    sqlite,
    tradeExecutor,
    logger,
    getUniverseBySource: () => [],
    getUniverseTiers,
  });
  await manager.init();
  return { sqlite, marketData, manager };
}

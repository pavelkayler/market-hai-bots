export type PaperOrder = {
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
  limitPrice: number;
  status: 'NEW' | 'FILLED' | 'CANCELLED';
  createdAtMs: number;
  filledAtMs?: number;
};

export type PaperPosition = {
  symbol: string;
  side: 'Buy' | 'Sell';
  size: number;
  avgPrice: number;
  openedAtMs: number;
  unrealizedPnl?: number;
};

export class PaperExecution {
  private readonly orders = new Map<string, PaperOrder>();
  private readonly openOrderIdsBySymbol = new Map<string, Set<string>>();
  private readonly positionsBySymbol = new Map<string, PaperPosition>();
  private sequence = 0;

  placeLimitOrder(input: { symbol: string; side: 'Buy' | 'Sell'; qty: number; limitPrice: number; tsMs: number }): PaperOrder {
    const orderId = `paper_${input.tsMs}_${++this.sequence}`;
    const order: PaperOrder = {
      orderId,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      limitPrice: input.limitPrice,
      status: 'NEW',
      createdAtMs: input.tsMs
    };

    this.orders.set(orderId, order);
    let symbolOrderIds = this.openOrderIdsBySymbol.get(input.symbol);
    if (!symbolOrderIds) {
      symbolOrderIds = new Set<string>();
      this.openOrderIdsBySymbol.set(input.symbol, symbolOrderIds);
    }
    symbolOrderIds.add(orderId);
    return { ...order };
  }

  cancelOpenOrders(input?: { symbol?: string }): void {
    const symbols = input?.symbol ? [input.symbol] : [...this.openOrderIdsBySymbol.keys()];
    for (const symbol of symbols) {
      const orderIds = this.openOrderIdsBySymbol.get(symbol);
      if (!orderIds) {
        continue;
      }

      for (const orderId of orderIds) {
        const order = this.orders.get(orderId);
        if (!order || order.status !== 'NEW') {
          continue;
        }
        order.status = 'CANCELLED';
      }

      this.openOrderIdsBySymbol.delete(symbol);
    }
  }

  clearAll(): void {
    this.cancelOpenOrders();
    this.positionsBySymbol.clear();
    this.sequence = 0;
  }

  removePosition(symbol: string): void {
    this.positionsBySymbol.delete(symbol);
  }

  getOpenOrders(): PaperOrder[] {
    return [...this.orders.values()].filter((order) => order.status === 'NEW').map((order) => ({ ...order }));
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.positionsBySymbol.values()].map((position) => ({ ...position }));
  }

  hasOpenOrder(symbol: string): boolean {
    const orderIds = this.openOrderIdsBySymbol.get(symbol);
    return !!orderIds && orderIds.size > 0;
  }

  hasOpenPosition(symbol: string): boolean {
    return this.positionsBySymbol.has(symbol);
  }

  getOpenPosition(symbol: string): PaperPosition | null {
    const position = this.positionsBySymbol.get(symbol);
    return position ? { ...position } : null;
  }

  onMarkTick(input: { symbol: string; mark: number; tsMs: number }): void {
    const orderIds = this.openOrderIdsBySymbol.get(input.symbol);
    if (orderIds && orderIds.size > 0) {
      for (const orderId of [...orderIds]) {
        const order = this.orders.get(orderId);
        if (!order || order.status !== 'NEW') {
          orderIds.delete(orderId);
          continue;
        }

        const shouldFill = (order.side === 'Buy' && input.mark <= order.limitPrice) || (order.side === 'Sell' && input.mark >= order.limitPrice);
        if (!shouldFill) {
          continue;
        }

        const existingPosition = this.positionsBySymbol.get(order.symbol);
        if (existingPosition && existingPosition.side !== order.side) {
          continue;
        }

        order.status = 'FILLED';
        order.filledAtMs = input.tsMs;
        orderIds.delete(orderId);

        if (!existingPosition) {
          this.positionsBySymbol.set(order.symbol, {
            symbol: order.symbol,
            side: order.side,
            size: order.qty,
            avgPrice: order.limitPrice,
            openedAtMs: input.tsMs,
            unrealizedPnl: 0
          });
          continue;
        }

        const nextSize = existingPosition.size + order.qty;
        const weightedAvgPrice = ((existingPosition.avgPrice * existingPosition.size) + (order.limitPrice * order.qty)) / nextSize;
        this.positionsBySymbol.set(order.symbol, { ...existingPosition, size: nextSize, avgPrice: weightedAvgPrice });
      }

      if (orderIds.size === 0) {
        this.openOrderIdsBySymbol.delete(input.symbol);
      }
    }

    const position = this.positionsBySymbol.get(input.symbol);
    if (!position) {
      return;
    }

    const signedPnl = position.side === 'Buy'
      ? (input.mark - position.avgPrice) * position.size
      : (position.avgPrice - input.mark) * position.size;
    this.positionsBySymbol.set(input.symbol, { ...position, unrealizedPnl: signedPnl });
  }
}

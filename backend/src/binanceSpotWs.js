// Binance integration removed. This placeholder is intentionally inert.
export function createBinanceSpotWs() {
  return {
    setSymbols() {},
    getSymbols() { return []; },
    getTickers() { return {}; },
    getStatus() { return { status: 'disabled', url: null }; },
    close() {},
  };
}

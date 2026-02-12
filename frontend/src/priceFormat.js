export function sourceTag(source) {
  const src = String(source || "").toUpperCase();
  if (src === "BT" || src === "BYBIT") return "BT";
    return "?";
}

export function formatPriceWithSource(ticker, fallback = "—") {
  const px = ticker?.mid ?? ticker?.last;
  if (!Number.isFinite(px)) return fallback;
  return `${px} (${sourceTag(ticker?.source)})`;
}

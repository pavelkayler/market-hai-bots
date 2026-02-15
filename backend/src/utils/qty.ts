const isPositiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const normalizeDecimal = (value: number, step: number): number => {
  const stepText = step.toString();
  const decimals = stepText.includes('.') ? stepText.split('.')[1]!.length : 0;
  const normalized = Number(value.toFixed(Math.min(decimals + 2, 12)));
  return Object.is(normalized, -0) ? 0 : normalized;
};

export const normalizeQty = (
  rawQty: number,
  qtyStep: number,
  minOrderQty: number,
  maxOrderQty?: number | null
): number | null => {
  if (!isPositiveFinite(rawQty) || !isPositiveFinite(qtyStep) || !isPositiveFinite(minOrderQty)) {
    return null;
  }

  let qty = Math.floor(rawQty / qtyStep) * qtyStep;

  if (isPositiveFinite(maxOrderQty) && qty > maxOrderQty) {
    qty = Math.floor(maxOrderQty / qtyStep) * qtyStep;
  }

  qty = normalizeDecimal(qty, qtyStep);

  if (qty < minOrderQty || qty <= 0) {
    return null;
  }

  return qty;
};

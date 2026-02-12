export function mergeNonUndefined(prev, patch) {
  const base = prev && typeof prev === "object" ? prev : {};
  if (!patch || typeof patch !== "object") return base;
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next;
}

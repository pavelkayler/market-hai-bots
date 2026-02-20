/**
 * Daily boundaries for trigger counters: MSK (UTC+3).
 * We use MSK day because user uses MSK for funding time display and expects "сутки" in that context.
 */
export function dayKeyMsk(tsMs: number): string {
  const d = new Date(tsMs + 3 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

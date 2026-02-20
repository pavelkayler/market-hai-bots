/**
 * After POSITION_CLOSED we wait 1 second before returning to WAITING_TRIGGER.
 */
export interface PostCloseState {
  lastClosedAtMs?: number;
}

export function shouldStayCooldown(nowMs: number, lastClosedAtMs?: number): boolean {
  if (!lastClosedAtMs) return false;
  return nowMs - lastClosedAtMs < 1000;
}

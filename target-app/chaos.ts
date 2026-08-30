/**
 * Injectable runtime conditions.
 *
 * The brief's point is that a stable enterprise UI still throws real runtime
 * errors. These are those errors, on demand, so the replay engine's handling of
 * each one is demonstrable instead of hypothetical.
 */

export const CHAOS_MODES = [
  'not_found',         // member search always misses
  'validation',        // opening deposit is always rejected as below minimum
  'session_timeout',   // the next content request bounces to /login
  'interstitial',      // an unexpected "System Notice" page appears once
  'slow',              // 6s stall on the next content request
  'error500',          // unhandled exception page
  'permission_denied', // operator lacks the sub-account entitlement
  /**
   * An interposed screen the recording has never seen: no signal matches it, no
   * checkpoint passes, and no locator in the artifact applies. This is the
   * honest shape of "the automation cannot safely proceed" -- not a known error
   * with a known handler, but a state nobody recorded. It is what the human
   * escalation path exists for.
   */
  'supervisor_override',
] as const;

export type ChaosMode = (typeof CHAOS_MODES)[number];

type Armed = { mode: ChaosMode; remaining: number };

let armed: Armed[] = [];

export function arm(mode: ChaosMode, times = 1): void {
  armed.push({ mode, remaining: times });
}

export function clear(): void {
  armed = [];
}

export function state(): Armed[] {
  return armed.map((a) => ({ ...a }));
}

/** True at most `times` times, then the mode disarms itself. */
export function consume(mode: ChaosMode): boolean {
  const hit = armed.find((a) => a.mode === mode && a.remaining > 0);
  if (!hit) return false;
  hit.remaining -= 1;
  armed = armed.filter((a) => a.remaining > 0);
  return true;
}

/** Non-consuming check, for modes that should persist across a whole run. */
export function peek(mode: ChaosMode): boolean {
  return armed.some((a) => a.mode === mode && a.remaining > 0);
}

/**
 * Condition evaluation and signal matching.
 *
 * Conditions are polled against fresh observations rather than delegated to any
 * surface-level "wait for load" primitive. That is not purism: verified against
 * the target app, page.waitForLoadState() does not fire for a navigation that
 * happens inside a frameset child frame, so a load-state wait would sail past
 * the very screens this system exists to drive. Polling a declarative condition
 * works there, and it is also the only wait model that means anything on a
 * desktop surface.
 */
import type { Capability, Condition, Signal } from '../schema/capability.js';
import type { Observation, Surface } from '../surface/types.js';
import { resolveLocator } from './locator.js';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

export async function evaluateCondition(
  cond: Condition,
  obs: Observation,
  surface: Surface,
): Promise<boolean> {
  if ('url_matches' in cond) {
    const re = new RegExp(cond.url_matches);
    // In a frameset the top-level URL freezes at the shell, so "any frame" is
    // the useful default; 'main' is available when a caller means the shell.
    if (cond.frame === 'main') return re.test(obs.url);
    return re.test(obs.url) || Object.values(obs.frameUrls).some((u) => re.test(u));
  }
  if ('text_present' in cond) return norm(obs.text).includes(norm(cond.text_present));
  if ('text_matches' in cond) return new RegExp(cond.text_matches, 'i').test(obs.text);
  if ('node_visible' in cond) {
    const { role, name } = cond.node_visible;
    return obs.nodes.some((n) => n.role === role && (!name || norm(n.name) === norm(name)));
  }
  if ('node_absent' in cond) {
    const { role, name } = cond.node_absent;
    return !obs.nodes.some((n) => n.role === role && (!name || norm(n.name) === norm(name)));
  }
  if ('value_matches' in cond) {
    const r = await resolveLocator(cond.value_matches.target, obs, surface);
    if (!r.ok) return false;
    const v = (await surface.read(r.ref, 'text')) ?? (await surface.read(r.ref, 'value')) ?? '';
    return new RegExp(cond.value_matches.pattern).test(v);
  }
  if ('all' in cond) {
    for (const c of cond.all) if (!(await evaluateCondition(c, obs, surface))) return false;
    return true;
  }
  if ('any' in cond) {
    for (const c of cond.any) if (await evaluateCondition(c, obs, surface)) return true;
    return false;
  }
  if ('not' in cond) return !(await evaluateCondition(cond.not, obs, surface));
  return false;
}

export function describeCondition(cond: Condition): string {
  if ('url_matches' in cond) return `url matches /${cond.url_matches}/`;
  if ('text_present' in cond) return `page contains "${cond.text_present}"`;
  if ('text_matches' in cond) return `page matches /${cond.text_matches}/`;
  if ('node_visible' in cond)
    return `a ${cond.node_visible.role}${cond.node_visible.name ? ` named "${cond.node_visible.name}"` : ''} is visible`;
  if ('node_absent' in cond)
    return `no ${cond.node_absent.role}${cond.node_absent.name ? ` named "${cond.node_absent.name}"` : ''} is visible`;
  if ('value_matches' in cond)
    return `${cond.value_matches.target.description} matches /${cond.value_matches.pattern}/`;
  if ('all' in cond) return cond.all.map(describeCondition).join(' AND ');
  if ('any' in cond) return cond.any.map(describeCondition).join(' OR ');
  if ('not' in cond) return `NOT (${describeCondition(cond.not)})`;
  return 'unknown condition';
}

/** Poll until the condition holds. Returns the observation it held on, so the
 *  caller does not have to observe again and risk a different world. */
export async function waitForCondition(
  cond: Condition,
  surface: Surface,
  timeoutMs: number,
  intervalMs = 250,
): Promise<{ ok: boolean; obs: Observation }> {
  const deadline = Date.now() + timeoutMs;
  let obs = await surface.observe();
  for (;;) {
    if (await evaluateCondition(cond, obs, surface)) return { ok: true, obs };
    if (Date.now() >= deadline) return { ok: false, obs };
    await new Promise((r) => setTimeout(r, intervalMs));
    obs = await surface.observe();
  }
}

export type SignalHit = { signal: Signal; captured: Record<string, string> };

/**
 * Which signals fire on this observation, most important first.
 *
 * Evaluated after EVERY step. "Record not found", "session expired" and
 * "unhandled exception" do not confine themselves to the step that anticipated
 * them; a per-step handler list is exactly how a replay blunders past one.
 */
export async function matchSignals(
  signals: Signal[],
  obs: Observation,
  surface: Surface,
): Promise<SignalHit[]> {
  const hits: SignalHit[] = [];
  const ordered = [...signals].sort((a, b) => a.priority - b.priority);
  for (const signal of ordered) {
    if (!(await evaluateCondition(signal.when, obs, surface))) continue;
    const captured: Record<string, string> = {};
    if (signal.outcome?.capture && 'text_matches' in signal.when) {
      const m = new RegExp(signal.when.text_matches, 'i').exec(obs.text);
      if (m) for (const [key, group] of Object.entries(signal.outcome.capture)) {
        if (m[group] !== undefined) captured[key] = m[group]!;
      }
    }
    hits.push({ signal, captured });
  }
  return hits;
}

/** Global signals plus this step's own, with step-scoped ones winning ties. */
export function signalsForStep(cap: Capability, stepId: string): Signal[] {
  const step = cap.steps.find((s) => s.id === stepId);
  const scoped = (step?.onError ?? []).map((s) => ({ ...s, priority: s.priority - 1000 }));
  return [...scoped, ...cap.signals];
}

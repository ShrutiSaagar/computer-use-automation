/**
 * The guardrail model.
 *
 * One decision function, used by BOTH engines. During discovery a refusal comes
 * back to the model as a tool error, so it re-plans instead of the run dying;
 * during replay the same refusal becomes a blocked_by_policy result. Two call
 * sites, one rulebook -- because a guardrail that the discovery agent can walk
 * around is not a guardrail.
 *
 * The risk model is split deliberately:
 *
 *   the ARTIFACT says how dangerous a step is   (a property of the action)
 *   the POLICY says what to do about that       (a property of the deployment)
 *
 * A capability recorded once is run by many institutions with different appetites
 * and different regulators. Baking "always ask a human" into the artifact would
 * mean re-recording to change a safety posture, and baking "always proceed" into
 * it would mean the artifact is unsafe by construction. Keeping them apart is
 * what lets the same recording run unattended in a test tenant and gated in
 * production.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Action } from '../surface/types.js';
import type { RiskClass } from '../schema/capability.js';

export const RiskResponse = z.enum(['allow', 'confirm', 'block']);
export type RiskResponse = z.infer<typeof RiskResponse>;

export const Policy = z.object({
  name: z.string(),
  /** The agent may not touch anything outside these origins. Checked on every
   *  navigate, and re-checked after every step in case the app redirected us
   *  somewhere we never asked to go. */
  allowedOrigins: z.array(z.string()).min(1),
  allowedActions: z.array(z.enum(['navigate', 'click', 'type', 'select', 'press', 'assert'])),
  /** Controls whose accessible name matches are never clicked, regardless of
   *  what the artifact says. A belt to the risk model's braces: it catches a
   *  dangerous control that was mis-classified as safe at record time. */
  deniedControlPatterns: z.array(z.string()).default([]),
  risk: z.object({
    safe: RiskResponse.default('allow'),
    risky: RiskResponse.default('allow'),
    irreversible: RiskResponse.default('confirm'),
  }),
  /** Coordinate clicking is off unless a deployment opts in: it is the one rung
   *  of the ladder that can act on the wrong thing without noticing. */
  allowCoordinateFallback: z.boolean().default(false),
  /** Bounded single-step LLM locator repair during replay. */
  assistedRecovery: z.boolean().default(false),
  assistedRecoveryBudget: z.object({
    perStep: z.number().int().default(1),
    perRun: z.number().int().default(2),
  }).default({ perStep: 1, perRun: 2 }),
  /** Minimum artifact status for an unattended (non-interactive) invocation. */
  requireStatus: z.enum(['draft', 'verified', 'approved']).default('verified'),
  /** Which deployment tiers this deployment's policy will touch. A capability
   *  whose surface.deployment is not listed is refused before a browser opens:
   *  the target is declared so that pointing sandbox traffic at a production
   *  institution is a policy refusal, not a surprise. */
  allowedDeployments: z.array(z.enum(['dev', 'sandbox', 'uat', 'prod']))
    .default(['dev', 'sandbox', 'uat', 'prod']),
  /** Whether this deployment permits composed capabilities at all. A production
   *  deployment that wants to pin exactly what runs may refuse any artifact
   *  that delegates to other skills. */
  allowComposition: z.boolean().default(true),
  /** How deep a `uses` chain may nest. A graph, not a rabbit hole. */
  maxCompositionDepth: z.number().int().min(1).default(3),
  maxSteps: z.number().int().default(60),
  maxRuntimeMs: z.number().int().default(300_000),
});
export type Policy = z.infer<typeof Policy>;

export function loadPolicy(path: string): Policy {
  return Policy.parse(parse(readFileSync(path, 'utf8')));
}

export type Decision =
  | { effect: 'allow' }
  | { effect: 'confirm'; rule: string; detail: string }
  | { effect: 'block'; rule: string; detail: string };

function originOf(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function isOriginAllowed(url: string, policy: Policy): boolean {
  const o = originOf(url);
  return !!o && policy.allowedOrigins.some((a) => originOf(a) === o);
}

/**
 * The single decision point. `controlName` is the accessible name of whatever is
 * about to be acted on, which is the only description of a control that a human
 * reviewer and the running system agree on.
 */
export function assertAllowed(
  action: Action,
  ctx: { policy: Policy; risk?: RiskClass; controlName?: string; currentUrl?: string },
): Decision {
  const { policy } = ctx;

  if (!policy.allowedActions.includes(action.kind as never)) {
    return { effect: 'block', rule: 'allowedActions', detail: `action "${action.kind}" is not permitted` };
  }

  if (action.kind === 'navigate' && !isOriginAllowed(action.url, policy)) {
    return {
      effect: 'block',
      rule: 'allowedOrigins',
      detail: `navigation to ${originOf(action.url) ?? action.url} is outside the allowlist [${policy.allowedOrigins.join(', ')}]`,
    };
  }

  if (ctx.currentUrl && !isOriginAllowed(ctx.currentUrl, policy)) {
    return {
      effect: 'block',
      rule: 'allowedOrigins',
      detail: `session drifted to ${originOf(ctx.currentUrl) ?? ctx.currentUrl}, outside the allowlist`,
    };
  }

  if (action.kind === 'click' && ctx.controlName) {
    for (const p of policy.deniedControlPatterns) {
      if (new RegExp(p, 'i').test(ctx.controlName)) {
        return {
          effect: 'block',
          rule: 'deniedControlPatterns',
          detail: `control "${ctx.controlName}" matches denied pattern /${p}/i`,
        };
      }
    }
  }

  const risk = ctx.risk ?? 'safe';
  const response = policy.risk[risk];
  if (response === 'block') {
    return { effect: 'block', rule: `risk.${risk}`, detail: `policy "${policy.name}" blocks ${risk} actions` };
  }
  if (response === 'confirm') {
    return {
      effect: 'confirm',
      rule: `risk.${risk}`,
      detail: `policy "${policy.name}" requires human confirmation for ${risk} actions`,
    };
  }
  return { effect: 'allow' };
}

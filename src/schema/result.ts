/**
 * What a replay hands back to the calling agent.
 *
 * The load-bearing decision is the top-level `status` union. The brief calls
 * conflating a business outcome with a failure "the most common design mistake
 * here", and it is right: if "no such member" arrives as an exception, every
 * caller either swallows real failures or treats data as an error.
 *
 *   success           the flow completed; outputs are populated
 *   business_outcome  the app gave a legitimate answer that is not the happy path
 *   escalated         a human was brought in; carries what they decided
 *   blocked_by_policy a guardrail refused; not the app's fault and not a bug
 *   failed            something broke; carries enough to debug it
 *
 * A failed precondition arrives as `failed` with class `precondition_not_met`:
 * "the conditions to run this are not met" is a failure the caller can act on
 * differently from a mid-flow crash -- retry-later, not report-a-bug.
 *
 * Note what is NOT here: "recovered". Dismissing an interstitial or re-authing
 * after a timeout does not change the caller's answer, so it is telemetry on the
 * step, not a result the caller has to branch on.
 */
import { z } from 'zod';
import { ErrorClass, type RiskClass } from './capability.js';

export type StrategyTrace = {
  /** Which rung of the ladder actually resolved the control. */
  kind: string;
  rank: number;
  /** rank > recordedRank: the app moved under us. Not fatal, but worth knowing
   *  before it becomes fatal. Aggregated per tenant, this is the drift alarm. */
  drift: boolean;
};

export type RecoveryTrace = {
  signalId: string;
  action: string;
  attempt: number;
  outcome: 'retried' | 'continued' | 'gave_up';
};

export type StepTrace = {
  stepId: string;
  action: string;
  status: 'ok' | 'recovered' | 'repaired' | 'skipped' | 'failed';
  ms: number;
  strategy?: StrategyTrace;
  recoveries: RecoveryTrace[];
  /** Set when bounded LLM repair replaced the locator for this step. */
  repair?: { from: string; to: string; model: string };
  note?: string;
};

export type ResultFlag =
  /** A risky or irreversible step ran because policy said `allow`. Always
   *  surfaced, so "we did the dangerous thing" is never silent. */
  | { kind: 'risky_action_allowed'; stepId: string; risk: RiskClass }
  | { kind: 'locator_drift'; stepId: string; recordedRank: number; actualRank: number }
  | { kind: 'assisted_repair'; stepId: string }
  | { kind: 'overlay_applied'; tenantId: string; steps: string[] }
  /** The replay environment differs from the recording's in a way we cannot
   *  impose (browser build, user agent). Not fatal; aggregated per tenant it is
   *  how you notice a fleet moving underneath you. */
  | { kind: 'environment_drift'; field: string; recorded: string; actual: string }
  /** The application is not the version this capability was recorded against. */
  | { kind: 'product_version_drift'; expected: string; detail: string }
  /** A `uses` skill was resolved and loaded for this run. */
  | { kind: 'skill_loaded'; name: string; capabilityId: string; version: number }
  /** A declared precondition did not hold and was established before step one
   *  (e.g. the session was signed on by the auth skill). Telemetry: the caller's
   *  answer is unchanged, so this is a flag, not a status. */
  | { kind: 'precondition_established'; name: string; via: string; check: string };

export type ReplayResult = {
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  tenantId?: string;
  startedAt: string;
  durationMs: number;
  evidenceDir: string;
  steps: StepTrace[];
  flags: ResultFlag[];
  /** Audit attribution: who asked for this run, on whose behalf. */
  invokedBy?: string;
  /** Caller-supplied idempotency marker, recorded so a retry after a crash can
   *  be correlated with the run it is retrying. Deduplication is a registry
   *  concern; this is the hook it keys on. */
  idempotencyKey?: string;
  /** The skills resolved and loaded for this run, as name=capabilityId@version. */
  skills?: string[];
} & (
  | { status: 'success'; outputs: Record<string, unknown> }
  | { status: 'business_outcome'; outcome: { code: string; message: string; data?: Record<string, string> } }
  | {
      status: 'escalated';
      intervention: { id: string; reason: string; resolution: string; operator?: string; note?: string };
      /** An escalation that the human resolved into a completed run still
       *  returns the outputs -- the caller asked for a result, not a story. */
      outputs?: Record<string, unknown>;
    }
  | { status: 'blocked_by_policy'; violation: { rule: string; detail: string; stepId?: string } }
  | {
      status: 'failed';
      error: {
        class: z.infer<typeof ErrorClass>;
        stepId: string;
        /** These three fields are the entire point of the failure branch: a
         *  caller or an on-call engineer should not need the evidence dir to
         *  know what went wrong. */
        message: string;
        expected: string;
        observed: string;
        evidence?: { screenshot?: string; snapshot?: string };
      };
    }
);

export const isTerminal = (s: ReplayResult['status']): boolean => s !== 'escalated';

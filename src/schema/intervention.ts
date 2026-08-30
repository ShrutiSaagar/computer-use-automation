/**
 * Human-in-the-loop.
 *
 * The control-transfer model is one lease over one live session. `controller` is
 * a single authoritative value -- automation or human, never both, never
 * ambiguous -- because "who is driving right now" is the question every other
 * part of the handoff depends on.
 */
import { z } from 'zod';

export const Controller = z.enum(['automation', 'human']);
export type Controller = z.infer<typeof Controller>;

export const InterventionReason = z.enum([
  /** Replay exhausted recoveries and repair on a step it cannot pass. */
  'stuck',
  /** Policy classifies this step as needing a person before it runs. */
  'confirm_risky',
  /** The discovery agent hit a wall and asked for help. */
  'discovery_blocked',
  /** A hard failure the operator may be able to clear manually. */
  'hard_failure',
]);
export type InterventionReason = z.infer<typeof InterventionReason>;

export const Resolution = z.enum([
  'resume',      // human fixed the state; continue from the next step
  'retry_step',  // re-run the step that failed
  'skip_step',   // the human did the step by hand; move on
  'abort',       // give up, return failure
  'approve',     // confirm_risky: proceed with the risky action
  'reject',      // confirm_risky: do not proceed
]);
export type Resolution = z.infer<typeof Resolution>;

export type Intervention = {
  id: string;
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  stepId?: string;
  stepIntent?: string;
  reason: InterventionReason;
  /** Everything the operator needs to act without reading the source. */
  context: {
    /** Why we stopped, in a sentence a human can act on. */
    summary: string;
    expected?: string;
    observed?: string;
    url: string;
    screenshot?: string;
    snapshot?: string;
    /** Populated for confirm_risky: exactly what is about to be submitted,
     *  with sensitive values already redacted. */
    aboutToSubmit?: Record<string, string>;
  };
  allowedResolutions: Resolution[];
  createdAt: string;
  resolvedAt?: string;
  resolution?: Resolution;
  operator?: string;
  note?: string;
};

/**
 * What the human did while they held the lease.
 *
 * Captured from the input pipe rather than reconstructed, because the operator
 * console forwards every event through us. Keystrokes into password-classified
 * fields are redacted at capture, not after.
 */
export type HumanAction = {
  ts: string;
  kind: 'mouse' | 'key' | 'text' | 'navigate';
  detail: string;
  redacted?: boolean;
};

/**
 * The capability artifact: a typed, versioned, reviewable description of a flow
 * that an AI agent can invoke and a human can audit.
 *
 * zod is the single source of truth here. From this one definition we get the
 * TypeScript types, runtime validation of every artifact we load, and -- via
 * z.toJSONSchema -- both the agent-facing tool schema and the human-readable
 * contract published by the catalog. Three consumers, one definition.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- targeting

/**
 * Which frame the control lives in. Legacy apps are full of framesets, and the
 * top-level URL stops changing once you are inside one -- so frame identity has
 * to be recorded explicitly rather than inferred from page.url().
 *
 * Resolved at replay by: name, then URL pattern, then ordinal, then main frame.
 */
export const FrameRef = z.object({
  name: z.string().optional(),
  urlPattern: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});
export type FrameRef = z.infer<typeof FrameRef>;

/**
 * One way of finding a control, ordered best-to-worst in Locator.strategies.
 *
 * The ordering is a claim about what survives time in an enterprise app:
 * semantics outlive structure, and structure outlives generated identifiers.
 */
export const Strategy = z.discriminatedUnion('kind', [
  /** Rank 0. Role + accessible name. Survives markup churn, and is the one
   *  strategy that also exists on desktop AX APIs -- so it ports. */
  z.object({
    kind: z.literal('role_name'),
    role: z.string(),
    name: z.string(),
    exact: z.boolean().default(false),
    nth: z.number().int().nonnegative().optional(),
  }),
  /** Rank 1. Explicit <label for>. Semantic, but only present where the app
   *  bothered -- which in legacy back-office software is rarely. */
  z.object({ kind: z.literal('label'), text: z.string(), exact: z.boolean().default(false) }),
  /** Rank 2. Placeholder / alt / title text. Author-supplied and fairly stable. */
  z.object({
    kind: z.literal('attr_text'),
    attr: z.enum(['placeholder', 'alt', 'title']),
    text: z.string(),
  }),
  /**
   * Rank 3. "The Nth control of role R at or after the text T."
   *
   * This is the one that makes table-soup automatable. When a field has no
   * label and no accessible name -- the common case -- the only durable thing
   * about it is that it sits next to a caption a human reads. We record the
   * caption and the offset, not the DOM path.
   */
  z.object({
    kind: z.literal('anchor'),
    anchorText: z.string(),
    role: z.string(),
    ordinal: z.number().int().nonnegative().default(0),
  }),
  /** Rank 4. Regex on the id, so ASP.NET container prefixes can shift
   *  (ctl00_A_txtFoo -> ctl00_B_txtFoo) without breaking us. */
  z.object({ kind: z.literal('id_pattern'), regex: z.string() }),
  /** Rank 5. A recorded CSS path. Brittle, but a real fallback. */
  z.object({ kind: z.literal('css'), value: z.string() }),
  /** Rank 6. Visible text. Fine for links, dangerous for anything repeated. */
  z.object({ kind: z.literal('text'), value: z.string(), exact: z.boolean().default(false) }),
  /**
   * Rank 7. Viewport-normalised coordinates. Last resort, policy-gated, and
   * deliberately kept in the schema because it is the strategy a screenshot-only
   * or OS-level surface would lead with. It is the bridge to non-DOM surfaces.
   */
  z.object({ kind: z.literal('coords'), nx: z.number(), ny: z.number() }),
]);
export type Strategy = z.infer<typeof Strategy>;

/**
 * A ranked ladder of ways to find one control, plus a guard.
 *
 * Two ideas do the work here:
 *
 * 1. No single strategy is trustworthy on a legacy surface, so we record all of
 *    them and let replay walk down until one resolves. `recordedRank` is which
 *    rung won at record time; if replay has to reach further down, that gap is a
 *    drift signal we surface rather than silently absorb.
 *
 * 2. `guard` is the safety net. A stale CSS path can still resolve -- to the
 *    wrong control. Whatever a strategy returns must match the guard's role and
 *    accessible name, or we reject it and keep walking. "Found an element" and
 *    "found the right element" are different claims.
 */
export const Locator = z.object({
  description: z.string(),
  frame: FrameRef.optional(),
  strategies: z.array(Strategy).min(1),
  recordedRank: z.number().int().nonnegative().default(0),
  guard: z.object({
    role: z.string(),
    name: z.string().optional(),
    tag: z.string().optional(),
  }),
});
export type Locator = z.infer<typeof Locator>;

// ---------------------------------------------------------------- conditions

/**
 * A declarative assertion about observed state.
 *
 * Deliberately NOT "call page.waitForLoadState". Conditions are polled against a
 * fresh observation until true or timeout, which (a) actually works through a
 * frameset, where page-level load states do not fire for child-frame navigation,
 * and (b) means the same condition evaluates identically on a desktop surface.
 */
export type Condition =
  | { url_matches: string; frame?: 'main' | 'any' }
  | { text_present: string }
  | { text_matches: string }
  | { node_visible: { role: string; name?: string } }
  | { node_absent: { role: string; name?: string } }
  | { value_matches: { target: Locator; pattern: string } }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ url_matches: z.string(), frame: z.enum(['main', 'any']).optional() }),
    z.object({ text_present: z.string() }),
    z.object({ text_matches: z.string() }),
    z.object({ node_visible: z.object({ role: z.string(), name: z.string().optional() }) }),
    z.object({ node_absent: z.object({ role: z.string(), name: z.string().optional() }) }),
    z.object({ value_matches: z.object({ target: Locator, pattern: z.string() }) }),
    z.object({ all: z.array(Condition) }),
    z.object({ any: z.array(Condition) }),
    z.object({ not: Condition }),
  ]),
);

// ---------------------------------------------------------------- error model

export const ERROR_CLASSES = [
  'locator_not_found',
  'ambiguous_locator',
  'guard_mismatch',
  'checkpoint_failed',
  /** The conditions under which this capability is allowed to START were not
   *  met, and policy said not to (or we could not) establish them. Distinct
   *  from a mid-flow failure on purpose: "you cannot run this here, yet" is a
   *  different answer from "the flow failed at step 7", and callers write
   *  different retry logic for each. */
  'precondition_not_met',
  /** The flow reported success, but the read-back verification of the effect in
   *  the application did not hold. Never silently swallowed. */
  'postcondition_failed',
  'timeout',
  'navigation_blocked',
  'unexpected_dialog',
  'session_lost',
  'surface_error',
  'output_extraction_failed',
  'guardrail_violation',
  /** The caller broke the input contract. Not the app's fault and not a bug in
   *  the flow -- surfaced separately so it is never mistaken for either. */
  'invalid_input',
  'internal',
] as const;
export const ErrorClass = z.enum(ERROR_CLASSES);
export type ErrorClass = z.infer<typeof ErrorClass>;

/**
 * The centrepiece of the error model.
 *
 * Signals are evaluated after EVERY step, not attached to the step that happens
 * to expect them. "Record not found", "session expired" and "unhandled
 * exception" do not politely appear only where you predicted them; wiring
 * handlers per-step is why replays blunder past them. An ordered global list is
 * why this one notices.
 *
 * The three classifications are the caller-facing distinction the brief asks
 * for, and conflating them is the mistake it warns about:
 *
 *   business_outcome -- a legitimate answer. "No such member" is data, not a crash.
 *   recoverable      -- we know how to handle this and carry on. Telemetry, not a result.
 *   hard_failure     -- stop, and hand back something debuggable.
 */
export const Signal = z.object({
  id: z.string(),
  description: z.string().optional(),
  when: Condition,
  classify: z.enum(['business_outcome', 'recoverable', 'hard_failure']),
  /** Lower runs first. Ties break on array order. */
  priority: z.number().int().default(100),
  outcome: z.object({
    code: z.string(),
    message: z.string(),
    /** Named capture groups from a `text_matches` pattern, surfaced to the caller. */
    capture: z.record(z.string(), z.number().int()).optional(),
  }).optional(),
  recover: z.object({
    do: z.enum(['click', 'reauth', 'wait_retry', 'navigate']),
    target: Locator.optional(),
    url: z.string().optional(),
    waitMs: z.number().int().default(1000),
    maxTimes: z.number().int().default(2),
    /** `restart` re-runs the flow from the first non-login step. Re-authenticating
     *  restores the SESSION but not the NAVIGATION -- after a timeout you are back
     *  at the app's landing screen, so retrying the step that failed would act on
     *  a screen that is no longer there. This is the difference between a
     *  session-recovery demo that works and one that only appears to. */
    then: z.enum(['retry_step', 'continue', 'restart']).default('retry_step'),
  }).optional(),
  errorClass: ErrorClass.optional(),
});
export type Signal = z.infer<typeof Signal>;

// ---------------------------------------------------------------- steps

/** A literal, a parameter reference, or a secret reference resolved at act time. */
export const ValueExpr = z.union([
  z.string(),
  z.object({ $param: z.string() }),
  /** e.g. { $secret: "env:CU_CORE_OPERATOR.password" }. The value never enters
   *  the artifact, the logs, or the screenshots -- only this reference does. */
  z.object({ $secret: z.string() }),
]);
export type ValueExpr = z.infer<typeof ValueExpr>;

/**
 * Risk is a property of the ACTION, so it travels with the capability to every
 * tenant that runs this product. What to DO about a given risk class is a
 * property of the DEPLOYMENT and lives in the policy file, not here. Baking the
 * response into the artifact would mean re-recording to change a safety posture.
 */
export const RiskClass = z.enum(['safe', 'risky', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

export const Step = z.object({
  id: z.string(),
  /** Prose: why this step exists. Read by human reviewers, and by the bounded
   *  repair prompt when a locator goes stale. */
  intent: z.string(),
  /** Steps act; outputs read. Extraction is declarative (see `outputs`) rather
   *  than a step kind, so what a capability RETURNS is legible from the contract
   *  without reading the step list. */
  /** Steps act, outputs read; `invoke` is the one exception -- it delegates to
   *  another recorded capability (a `uses` slot) instead of acting on a control.
   *  The graph is declared in the artifact, so replay stays model-free. */
  action: z.enum(['navigate', 'click', 'type', 'select', 'press', 'assert', 'invoke']),
  target: Locator.optional(),
  value: ValueExpr.optional(),
  url: z.string().optional(),
  /** For `invoke` steps: the local name of the `uses` entry to run. */
  uses: z.string().optional(),
  /** For `invoke` steps: the child capability's typed inputs. */
  args: z.record(z.string(), ValueExpr).optional(),
  risk: RiskClass.default('safe'),
  /** Polled until true before the step is considered ready. */
  waitFor: Condition.optional(),
  /** Asserted AFTER the action: "did the click actually do the thing?" */
  checkpoint: Condition.optional(),
  timeoutMs: z.number().int().default(10_000),
  retries: z.number().int().default(1),
  /** Step-scoped signals, evaluated before the global list. */
  onError: z.array(Signal).default([]),
}).refine((s) => s.action !== 'invoke' || s.risk === 'safe', {
  // Risk is declared where the action happens: on the child's own steps, gated
  // by the child's own run. An `invoke` step bypasses the per-step policy gate
  // (it acts on no control), so letting it claim a risk class would let that
  // class go unenforced.
  message: 'invoke steps must be risk "safe"; risk belongs on the delegated capability\'s steps',
  path: ['risk'],
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------- contract

export const SENSITIVITY = ['none', 'identifier', 'account_number', 'amount', 'pii', 'secret'] as const;

export const InputParam = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Drives redaction. Anything above 'none' is masked in logs and screenshots. */
  sensitivity: z.enum(SENSITIVITY).default('none'),
  /** The concrete value used during discovery. Used by the compiler to
   *  parameterise the recorded trace, and as the example in the catalog. */
  example: z.string().optional(),
});
export type InputParam = z.infer<typeof InputParam>;

export const OutputField = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  from: Locator,
  extract: z.enum(['text', 'value', 'attr']).default('text'),
  attr: z.string().optional(),
  /** Doubles as a correctness assertion: an extracted value that does not match
   *  is an output_extraction_failed, not a silently wrong answer. */
  pattern: z.string().optional(),
  sensitivity: z.enum(SENSITIVITY).default('none'),
});
export type OutputField = z.infer<typeof OutputField>;

// ---------------------------------------------------------------- composition

/**
 * One slot in a capability's dependency graph: another recorded capability this
 * one loads to do part of the job (sign on, look a member up).
 *
 * The graph is STATIC and declared in the artifact, not chosen at replay time.
 * That is what keeps composition deterministic: the model (or a human author)
 * chose the composition once, it is reviewable like the rest of the artifact,
 * and replay only executes it. `version` is a range over the child's artifact
 * versions -- "*", "^1", ">=1", ">=1 <3", or an exact "2" -- resolved at load
 * time, and the resolved version is pinned into the run's evidence.
 */
export const UsesRef = z.object({
  /** Local name other parts of the artifact use to refer to this skill. */
  name: z.string(),
  capabilityId: z.string(),
  version: z.string().default('*'),
  /** Why this skill is here -- read by human reviewers of the composition. */
  purpose: z.string().optional(),
});
export type UsesRef = z.infer<typeof UsesRef>;

/**
 * The conditions under which this capability is ALLOWED TO START, stated as
 * checkable predicates over observed state -- never as stored state itself.
 *
 * The distinction is the whole design. A stored session (cookies, tokens, a
 * "logged in = true" flag) is a secret (it IS the credential), dead in minutes,
 * bound to one tenant/user/environment, hostile to audit attribution (replaying
 * it means ACTING AS whoever it belonged to), and quietly fatal to the
 * determinism story. So the artifact carries:
 *
 *   `check`     -- how to TELL the requirement holds, in the same Condition
 *                  vocabulary the steps use. The state itself is never stored.
 *   `establish` -- how to GET THERE when it does not hold: run another skill.
 *   `onNotMet`  -- who decides when it cannot be established: fix it, fail
 *                  fast as `precondition_not_met`, or bring in a human.
 *
 * Defense in depth, honestly stated: the check is the cheap FIRST line, not the
 * mechanism. If it is ever wrong, the first step's `waitFor` is the second net
 * and the global session-expiry signal is the third.
 */
export const Requires = z.object({
  session: z.object({
    describe: z.string().optional(),
    /** Predicate that is TRUE when the requirement holds (e.g. the sign-on
     *  button is absent). Overridable per tenant -- renaming controls is the
     *  most common way one tenant's configuration differs from another's. */
    check: Condition,
    /** Run this `uses` slot when `check` fails. When absent, the engine falls
     *  back to the legacy inline `auth.loginStepIds` if the artifact has them. */
    establish: z.object({ uses: z.string() }).optional(),
    onNotMet: z.enum(['establish', 'fail', 'escalate']).default('establish'),
    /** Where to read WHO the automation is acting as, once signed on. The value
     *  is written to the audit evidence (redacted per its sensitivity) -- proof
     *  of "we acted as X", never a reusable token. */
    identity: Locator.optional(),
  }).optional(),
  /** Business-data preconditions, verified by invoking another skill: "the
   *  member must exist" is a condition on the WORLD, checked through the same
   *  deterministic replay machinery as everything else. */
  data: z.array(z.object({
    name: z.string(),
    describe: z.string().optional(),
    /** The `uses` slot to invoke. Met iff the child returns `success`. */
    via: z.string(),
    args: z.record(z.string(), ValueExpr).default({}),
    /** Child business-outcome codes that mean "requirement not met, but this is
     *  a legitimate answer" (e.g. MEMBER_NOT_FOUND). */
    notMetOutcomes: z.array(z.string()).default([]),
    /** propagate: the parent's answer IS the child's outcome (a child's honest
     *  answer is not an error). fail: precondition_not_met. escalate: human. */
    onNotMet: z.enum(['propagate', 'fail', 'escalate']).default('propagate'),
  })).default([]),
});
export type Requires = z.infer<typeof Requires>;


/**
 * The environment the recording was made in.
 *
 * Stored because "it worked on my machine" is not a replay guarantee. The first
 * five fields are re-applied to the browser on every replay, so a run matches its
 * recording by construction rather than because two hardcoded constants happened
 * to agree. The last two are recorded but not imposed: you cannot honestly force
 * a browser version, and pretending to be one you are not is worse than noticing
 * you are a different one.
 */
export const Environment = z.object({
  /** Moves bounding boxes, decides what is visible under a responsive layout,
   *  and is the denominator for every coordinate. */
  viewport: z.object({ width: z.number().int(), height: z.number().int() }),
  deviceScaleFactor: z.number().default(1),
  /** Browser-rendered controls carry locale-dependent accessible names -- a file
   *  input reads "Choose File" in en-US and something else elsewhere -- so a
   *  role+name locator recorded in one locale can simply stop matching in another. */
  locale: z.string().default('en-US'),
  /** Keeps date-shaped outputs from shifting by a day with the runner's location. */
  timezoneId: z.string().default('UTC'),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).default('light'),
  browser: z.object({ name: z.string(), version: z.string() }).optional(),
  userAgent: z.string().optional(),
});
export type Environment = z.infer<typeof Environment>;

// ---------------------------------------------------------------- capability

export const Capability = z.object({
  /** 1.0 -> 1.1 added `requires`, `uses`, `invoke` steps, `post` and
   *  `surface.deployment`. All additions are optional-with-defaults, so a 1.0
   *  artifact parses unchanged -- composition is additive, not a migration. */
  schemaVersion: z.union([z.literal('1.0'), z.literal('1.1')]),
  id: z.string(),
  /** Monotonic. An artifact is immutable once verified; changes cut a new version. */
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  /** draft -> verified (self-replayed clean) -> approved (a human signed off).
   *  Unattended invocation can be gated on this by policy. */
  status: z.enum(['draft', 'verified', 'approved']).default('draft'),

  /**
   * Identity is the VENDOR PRODUCT, not the tenant. Hundreds of institutions run
   * the same core banking product with different branding; keying artifacts to
   * the product is what lets one recording serve all of them, with a
   * TenantOverlay carrying the differences.
   */
  product: z.object({
    id: z.string(),
    vendor: z.string(),
    version: z.string(),
    /** Asserted once at the start of a replay: "is this still the product and
     *  version this flow was recorded against?". Supplied by the product pack,
     *  not by the recording, because it is a fact about the product. A mismatch
     *  is flagged rather than fatal -- one tenant upgrading ahead of the others
     *  is a thing to notice early, not a reason to refuse work. */
    fingerprint: Condition.optional(),
  }),

  /** Captured at discovery, re-applied at replay. See Environment. */
  environment: Environment.optional(),

  surface: z.object({
    kind: z.enum(['web', 'legacy_web', 'desktop']),
    entryUrl: z.string(),
    /** WHICH DEPLOYMENT this entry point leads to. Nothing structural else
     *  stops sandbox traffic from being pointed at a production institution,
     *  and at a bank that is the worst available failure -- so the target is
     *  declared and the deployment's policy refuses mismatches. An untagged
     *  (1.0) artifact defaults to `sandbox`, the same tier the learning engine
     *  stamps on a fresh recording: a production policy then refuses it until a
     *  human tags it deliberately, rather than letting it through by omission. */
    deployment: z.enum(['dev', 'sandbox', 'uat', 'prod']).default('sandbox'),
  }),

  auth: z.object({
    /** A reference, never a value. Resolved from env at act time. */
    credentialRef: z.string(),
    loginStepIds: z.array(z.string()).default([]),
  }).optional(),

  /** Other skills this capability loads (see UsesRef). */
  uses: z.array(UsesRef).default([]),
  /** The conditions to run (see Requires). Evaluated at replay preflight. */
  requires: Requires.optional(),
  inputs: z.array(InputParam).default([]),
  outputs: z.array(OutputField).default([]),
  steps: z.array(Step).min(1),
  signals: z.array(Signal).default([]),
  /** Capability-level success assertion, on top of per-step checkpoints. */
  checkpoint: Condition,
  /**
   * Read-back post-condition: verified AFTER the checkpoint and outputs, and
   * about the EFFECT in the application, not the final screen. A checkpoint
   * proves what the screen says; a post-condition proves the world agrees.
   * Failure is a `postcondition_failed` failure, never a silently wrong
   * success handed to a banking agent.
   */
  post: z.object({
    describe: z.string().optional(),
    condition: Condition,
  }).optional(),

  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    recordedAt: z.string(),
    evidenceDir: z.string(),
    /** Outcome detectors the model proposed that were rejected because they
     *  matched a screen the successful run visited. Kept for review: a rejected
     *  detector usually means the model saw a real outcome but described it by
     *  the wrong text. */
    rejectedSignals: z.array(z.object({ code: z.string(), matched: z.string() })).optional(),
    /** Inputs the model proposed that were actually credentials. Credentials come
     *  from a reference, never from the caller, so the compiler removes them. */
    removedCredentialInputs: z.array(z.string()).optional(),
    /** The id the model asked for, when it differed from the canonical one. */
    declaredId: z.string().optional(),
    /** Detectors the run proposed that the curated product signal pack already
     *  covers. Kept visible so "the model found this too" is not lost. */
    supersededSignals: z.array(z.string()).optional(),
    /** Output shape assertions the run proposed that the value it actually
     *  extracted does not satisfy. Dropped, and kept here for review -- a
     *  rejected pattern usually means the model guessed the formatting. */
    rejectedOutputPatterns: z.array(z.object({
      output: z.string(), pattern: z.string(), value: z.string(),
    })).optional(),
    selfReplay: z.object({
      passed: z.boolean(),
      runId: z.string(),
      error: z.string().optional(),
    }).optional(),
  }),

  stats: z.object({
    replays: z.number().int().default(0),
    successes: z.number().int().default(0),
    lastVerifiedAt: z.string().optional(),
    meanStrategyRank: z.number().optional(),
  }).default({ replays: 0, successes: 0 }),
});
export type Capability = z.infer<typeof Capability>;

/**
 * Per-tenant specialisation of a product-level capability.
 *
 * The alternative -- re-recording the flow for each of hundreds of tenants -- is
 * the thing this schema exists to avoid. An overlay is a small, reviewable patch:
 * a different base URL, a handful of relabelled controls, an extra interstitial
 * that only this institution's configuration shows.
 */
export const TenantOverlay = z.object({
  schemaVersion: z.literal('1.0'),
  tenantId: z.string(),
  institution: z.string(),
  appliesTo: z.object({ capabilityId: z.string(), capabilityVersion: z.number().int() }),
  entryUrl: z.string().optional(),
  /** A tenant whose staff run at a different resolution or locale. */
  environment: Environment.optional(),
  /** stepId -> partial locator/value override. */
  steps: z.record(z.string(), z.object({
    target: Locator.partial().optional(),
    value: ValueExpr.optional(),
    /** Waits and checkpoints assert on control names, and renaming controls is
     *  the single most common way one tenant's configuration of a product
     *  differs from another's -- so they have to be overridable too, or the
     *  overlay can only fix half the problem. */
    waitFor: Condition.optional(),
    checkpoint: Condition.optional(),
    skip: z.boolean().optional(),
  })).default({}),
  /** Signals only this tenant needs -- prepended, so they win on ties. */
  addSignals: z.array(Signal).default([]),
  /** This tenant's configuration may rename the controls the session check
   *  asserts on, so the check is overridable like everything else. */
  session: z.object({ check: Condition.optional() }).optional(),
  post: z.object({ condition: Condition.optional() }).optional(),
  /** If this institution runs the product on a different deployment tier. */
  deployment: z.enum(['dev', 'sandbox', 'uat', 'prod']).optional(),
  notes: z.string().optional(),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

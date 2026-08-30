/**
 * The deterministic replay engine -- the production execution path.
 *
 * No model decides anything here. Given an artifact and typed inputs, every
 * branch is taken from data recorded at discovery time or declared in the policy
 * file. The one exception is bounded locator repair, which is off by default,
 * capped, never runs on a risky step, may only replace WHERE a step acts (never
 * WHAT it does), and is loaded by dynamic import so the LLM SDK is not even
 * resident when it is disabled.
 *
 * The step loop is deliberately uniform:
 *
 *     wait -> observe -> match signals -> resolve -> policy -> act
 *          -> observe -> match signals -> checkpoint
 *
 * Signals are matched twice per step, before and after acting, because the state
 * that ends a run is frequently created by the PREVIOUS step: a click that
 * silently landed on a session-expiry redirect is discovered when the next step
 * looks around, not when it happened.
 */
import { randomUUID } from 'node:crypto';
import type {
  Capability, Condition, ErrorClass, Signal, Step, TenantOverlay, ValueExpr,
} from '../schema/capability.js';
import type { ReplayResult, ResultFlag, StepTrace, RecoveryTrace } from '../schema/result.js';
import type { Observation, Surface } from '../surface/types.js';
import type { Policy } from '../policy/guardrails.js';
import { assertAllowed } from '../policy/guardrails.js';
import { Redactor, resolveSecretExpr } from '../policy/redact.js';
import type { Evidence } from '../evidence/logger.js';
import type { SessionBroker } from '../hitl/broker.js';
import { resolveLocator } from './locator.js';
import { describeCondition, evaluateCondition, matchSignals, signalsForStep, waitForCondition } from './detect.js';

export type ReplayDeps = {
  surface: Surface;
  policy: Policy;
  redactor: Redactor;
  evidence: Evidence;
  /** Absent means escalation is impossible; a stuck run then fails rather than
   *  hanging forever waiting for an operator who is not there. */
  broker?: SessionBroker;
  overlay?: TenantOverlay;
};

// ---------------------------------------------------------------- overlay

/**
 * Merge a tenant overlay onto a product-level capability.
 *
 * This is the whole multi-tenant story in one function: hundreds of institutions
 * run the same vendor product, so the recording is keyed to the product and the
 * per-institution differences arrive as a small reviewable patch. Overlay signals
 * are prepended so a tenant-specific rule wins a tie against the product default.
 */
export function applyOverlay(cap: Capability, overlay: TenantOverlay): { cap: Capability; touched: string[] } {
  const touched: string[] = [];

  /**
   * Rebase every recorded URL onto the tenant's origin.
   *
   * A recording carries the origin it was made against, in navigate steps and in
   * any url_matches condition derived from what was observed. Overriding only
   * `entryUrl` looks like it works and then silently drives the wrong
   * institution's system -- which, at a bank, is the worst possible failure. So
   * the origin swap is applied to everything the recording captured.
   */
  const origin = (u: string): string | null => { try { return new URL(u).origin; } catch { return null; } };
  const from = origin(cap.surface.entryUrl);
  const to = overlay.entryUrl ? origin(overlay.entryUrl) : null;
  const rebase = <T,>(v: T): T => {
    if (!from || !to || from === to) return v;
    if (typeof v === 'string') return v.split(from).join(to) as unknown as T;
    if (Array.isArray(v)) return v.map(rebase) as unknown as T;
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x)])) as T;
    }
    return v;
  };

  const steps = cap.steps.map((raw) => {
    const s = rebase(raw);
    const patch = overlay.steps[s.id];
    if (!patch) return s;
    touched.push(s.id);
    return {
      ...s,
      target: patch.target ? ({ ...s.target, ...patch.target } as Step['target']) : s.target,
      value: patch.value ?? s.value,
      waitFor: patch.waitFor ?? s.waitFor,
      checkpoint: patch.checkpoint ?? s.checkpoint,
      ...(patch.skip ? { action: 'assert' as const, target: undefined } : {}),
    };
  });
  return {
    cap: {
      ...cap,
      surface: { ...cap.surface, entryUrl: overlay.entryUrl ?? cap.surface.entryUrl },
      steps,
      checkpoint: rebase(cap.checkpoint),
      outputs: rebase(cap.outputs),
      // Overlay signals are prepended so a tenant-specific rule wins a tie
      // against the product default.
      signals: [...overlay.addSignals, ...rebase(cap.signals)],
    },
    touched,
  };
}

// ---------------------------------------------------------------- contract

export type InputCheck = { ok: true; values: Record<string, string> } | { ok: false; message: string };

export function validateInputs(cap: Capability, given: Record<string, unknown>): InputCheck {
  const values: Record<string, string> = {};
  for (const p of cap.inputs) {
    const raw = given[p.name] ?? p.default;
    if (raw === undefined || raw === '') {
      if (p.required) return { ok: false, message: `missing required input "${p.name}" (${p.description})` };
      continue;
    }
    const v = String(raw);
    if (p.type === 'number' && !Number.isFinite(Number(v))) {
      return { ok: false, message: `input "${p.name}" must be a number, got "${v}"` };
    }
    if (p.pattern && !new RegExp(p.pattern).test(v)) {
      return { ok: false, message: `input "${p.name}" must match /${p.pattern}/, got "${v}"` };
    }
    if (p.enum && !p.enum.includes(v)) {
      return { ok: false, message: `input "${p.name}" must be one of [${p.enum.join(', ')}], got "${v}"` };
    }
    values[p.name] = v;
  }
  const unknown = Object.keys(given).filter((k) => !cap.inputs.some((p) => p.name === k));
  if (unknown.length) return { ok: false, message: `unknown input(s): ${unknown.join(', ')}` };
  return { ok: true, values };
}

function resolveValue(expr: ValueExpr | undefined, values: Record<string, string>, redactor: Redactor): string {
  if (expr === undefined) return '';
  if (typeof expr === 'string') return expr;
  if ('$param' in expr) {
    const v = values[expr.$param];
    if (v === undefined) throw new Error(`step references unknown parameter "${expr.$param}"`);
    return v;
  }
  return resolveSecretExpr(expr.$secret, redactor);
}

// ---------------------------------------------------------------- engine

type Halt =
  | { kind: 'business'; code: string; message: string; data: Record<string, string> }
  | { kind: 'blocked'; rule: string; detail: string; stepId?: string }
  | { kind: 'escalated'; id: string; reason: string; resolution: string; operator?: string; note?: string }
  | { kind: 'failed'; class: ErrorClass; stepId: string; message: string; expected: string; observed: string };

export async function replay(
  cap: Capability,
  rawInputs: Record<string, unknown>,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const { surface, policy, redactor, evidence, broker } = deps;
  const runId = evidence.runId;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const steps: StepTrace[] = [];
  const flags: ResultFlag[] = [];
  let repairsUsed = 0;

  let active = cap;
  if (deps.overlay) {
    const merged = applyOverlay(cap, deps.overlay);
    active = merged.cap;
    flags.push({ kind: 'overlay_applied', tenantId: deps.overlay.tenantId, steps: merged.touched });
    evidence.event('overlay_applied', { tenantId: deps.overlay.tenantId, steps: merged.touched });
  }

  const done = (extra: Partial<ReplayResult>): ReplayResult =>
    ({
      runId,
      capabilityId: active.id,
      capabilityVersion: active.version,
      tenantId: deps.overlay?.tenantId,
      startedAt,
      durationMs: Date.now() - t0,
      evidenceDir: evidence.dir,
      steps,
      flags,
      ...extra,
    }) as ReplayResult;

  const fromHalt = (h: Halt): ReplayResult => {
    switch (h.kind) {
      case 'business':
        return done({ status: 'business_outcome', outcome: { code: h.code, message: h.message, data: h.data } });
      case 'blocked':
        return done({ status: 'blocked_by_policy', violation: { rule: h.rule, detail: h.detail, stepId: h.stepId } });
      case 'escalated':
        return done({
          status: 'escalated',
          intervention: { id: h.id, reason: h.reason, resolution: h.resolution, operator: h.operator, note: h.note },
        });
      case 'failed':
        return done({
          status: 'failed',
          error: {
            class: h.class, stepId: h.stepId, message: h.message,
            expected: h.expected, observed: h.observed,
          },
        });
    }
  };

  evidence.event('replay_start', {
    capability: `${active.id}@${active.version}`, status: active.status,
    policy: policy.name, inputs: Object.keys(rawInputs),
  });

  // ---- contract gates, before we touch the application at all

  const checked = validateInputs(active, rawInputs);
  if (!checked.ok) {
    evidence.event('invalid_input', { message: checked.message });
    return done({
      status: 'failed',
      error: {
        class: 'invalid_input', stepId: '(pre-flight)', message: checked.message,
        expected: active.inputs.map((p) => `${p.name}: ${p.type}${p.required ? '' : '?'}`).join(', '),
        observed: JSON.stringify(rawInputs),
      },
    });
  }
  const values = checked.values;
  for (const p of active.inputs) redactor.addSensitive(p.name, values[p.name], p.sensitivity);

  const rank = { draft: 0, verified: 1, approved: 2 };
  if (rank[active.status] < rank[policy.requireStatus]) {
    const detail = `capability status is "${active.status}" but policy "${policy.name}" requires "${policy.requireStatus}" for unattended replay`;
    evidence.event('blocked_by_policy', { rule: 'requireStatus', detail });
    return done({ status: 'blocked_by_policy', violation: { rule: 'requireStatus', detail } });
  }

  // ---- helpers bound to this run

  const shot = async (label: string): Promise<string | undefined> => {
    try { return evidence.screenshot(label, await surface.screenshot()); } catch { return undefined; }
  };

  const escalate = async (
    req: Parameters<SessionBroker['escalate']>[0],
  ): Promise<{ resolution: string; note?: string; operator?: string; id: string } | null> => {
    if (!broker) return null;
    const screenshot = await shot(`escalation-${req.stepId ?? 'run'}`);
    const obs = await surface.observe();
    const snapshot = evidence.snapshot(`escalation-${req.stepId ?? 'run'}`, obs.nodes);
    evidence.event('intervention_raised', { reason: req.reason, stepId: req.stepId, summary: req.summary });
    const before = obs;
    const r = await broker.escalate({ ...req, screenshot, snapshot, url: obs.url });
    const after = await surface.observe();
    // The semantic record of the handoff: what the human actually changed, in AX
    // terms. More useful to an auditor a year later than a stream of raw clicks.
    const diff = {
      appeared: after.nodes.filter((n) => n.name && !before.nodes.some((b) => b.role === n.role && b.name === n.name))
        .map((n) => `${n.role} "${n.name}"`).slice(0, 25),
      disappeared: before.nodes.filter((n) => n.name && !after.nodes.some((a) => a.role === n.role && a.name === n.name))
        .map((n) => `${n.role} "${n.name}"`).slice(0, 25),
      urlBefore: before.url, urlAfter: after.url,
      frameUrlsBefore: before.frameUrls, frameUrlsAfter: after.frameUrls,
    };
    evidence.snapshot(`handoff-diff-${req.stepId ?? 'run'}`, diff);
    evidence.event('intervention_resolved', {
      resolution: r.resolution, operator: r.operator, note: r.note,
      humanActions: broker.humanActions.length,
    });
    evidence.snapshot(`human-actions-${req.stepId ?? 'run'}`, broker.humanActions);
    return { ...r, id: broker.pending?.id ?? 'resolved' };
  };

  // ---- entry
  //
  // From here to the success return, everything is wrapped: an unexpected throw
  // still has to come back as a structured result. A calling agent should never
  // have to distinguish "the flow failed" from "the engine failed" -- that is a
  // contract, not a nicety.
  try {

  if (!(await runNavigate(active.surface.entryUrl))) {
    return fromHalt({
      kind: 'blocked', rule: 'allowedOrigins',
      detail: `entry URL ${active.surface.entryUrl} is outside the allowlist`,
    });
  }

  // Is this still the software this flow was recorded against? Checked once, on
  // arrival, and only flagged: a tenant that has upgraded ahead of the others is
  // something to notice on the day rather than to refuse work over.
  if (active.product.fingerprint) {
    const fp = await waitForCondition(active.product.fingerprint, surface, 4000);
    if (!fp.ok) {
      flags.push({
        kind: 'product_version_drift',
        expected: `${active.product.id}@${active.product.version}`,
        detail: describeCondition(active.product.fingerprint),
      });
      evidence.event('product_version_drift', {
        expected: `${active.product.id}@${active.product.version}`,
        check: describeCondition(active.product.fingerprint),
      });
    }
  }

  async function runNavigate(url: string): Promise<boolean> {
    const d = assertAllowed({ kind: 'navigate', url }, { policy });
    if (d.effect === 'block') { evidence.event('blocked_by_policy', { rule: d.rule, detail: d.detail }); return false; }
    await (broker ? broker.withControl(() => surface.act({ kind: 'navigate', url })) : surface.act({ kind: 'navigate', url }));
    return true;
  }

  // ---- signal handling, shared by the pre- and post-action checks

  type SignalVerdict =
    | { kind: 'none' }
    | { kind: 'halt'; halt: Halt }
    /** The action must be performed again. */
    | { kind: 'recovered'; traces: RecoveryTrace[] }
    /** The obstruction was cleared and the step itself is fine -- go back to
     *  waiting for whatever we were waiting for, without re-acting. Dismissing a
     *  maintenance banner should not re-click Sign On. */
    | { kind: 'continue'; traces: RecoveryTrace[] }
    | { kind: 'restart'; traces: RecoveryTrace[] };

  const recoveryCounts = new Map<string, number>();

  /** `known` lets a caller pass the observation it already has. Observing is the
   *  single most expensive thing this engine does; re-observing to look at the
   *  same instant twice is pure waste. */
  async function handleSignals(step: Step | null, phase: 'pre' | 'post', known?: Observation): Promise<SignalVerdict> {
    const obs = known ?? (await surface.observe());
    const pool = step ? signalsForStep(active, step.id) : active.signals;
    const hits = await matchSignals(pool, obs, surface);
    if (!hits.length) return { kind: 'none' };
    const hit = hits[0]!;
    const s: Signal = hit.signal;
    evidence.event('signal_matched', { signal: s.id, classify: s.classify, phase, stepId: step?.id });

    if (s.classify === 'business_outcome' && s.outcome) {
      await shot(`outcome-${s.outcome.code.toLowerCase()}`);
      return {
        kind: 'halt',
        halt: { kind: 'business', code: s.outcome.code, message: s.outcome.message, data: hit.captured },
      };
    }

    if (s.classify === 'hard_failure') {
      await shot(`hard-failure-${s.id}`);
      return {
        kind: 'halt',
        halt: {
          kind: 'failed', class: s.errorClass ?? 'surface_error', stepId: step?.id ?? '(entry)',
          message: `signal "${s.id}" fired: ${s.description ?? describeCondition(s.when)}`,
          expected: `not ${describeCondition(s.when)}`,
          observed: obs.text.slice(0, 400).replace(/\s+/g, ' '),
        },
      };
    }

    if (s.classify === 'recoverable' && s.recover) {
      const used = recoveryCounts.get(s.id) ?? 0;
      if (used >= s.recover.maxTimes) {
        return {
          kind: 'halt',
          halt: {
            kind: 'failed', class: 'internal', stepId: step?.id ?? '(entry)',
            message: `recovery "${s.id}" exhausted after ${used} attempt(s)`,
            expected: `${describeCondition(s.when)} clears after recovery`,
            observed: 'condition still present',
          },
        };
      }
      recoveryCounts.set(s.id, used + 1);
      const traces: RecoveryTrace[] = [];
      const r = s.recover;
      evidence.event('recovery_start', { signal: s.id, action: r.do, attempt: used + 1 });

      if (r.do === 'wait_retry') {
        await new Promise((res) => setTimeout(res, r.waitMs));
      } else if (r.do === 'navigate' && r.url) {
        await runNavigate(r.url);
      } else if (r.do === 'click' && r.target) {
        const res = await resolveLocator(r.target, obs, surface, { allowCoordinateFallback: policy.allowCoordinateFallback });
        if (res.ok) {
          try {
            await (broker ? broker.withControl(() => surface.act({ kind: 'click', ref: res.ref })) : surface.act({ kind: 'click', ref: res.ref }));
          } catch (e) {
            evidence.event('recovery_click_error', { signal: s.id, error: String((e as Error).message).slice(0, 200) });
          }
        } else {
          evidence.event('recovery_target_unresolved', { signal: s.id, detail: res.detail });
        }
      } else if (r.do === 'reauth') {
        // Re-authenticate from the credential REFERENCE, mid-run, and then retry
        // the step that was interrupted. The password is fetched from the
        // environment at this moment and never written anywhere.
        await runNavigate(active.surface.entryUrl);
        // Confirm we are actually looking at the sign-on screen before typing
        // credentials into it. Without this the reauth types into whatever
        // happens to be on screen and fails three steps later as a timeout.
        const atLogin = await waitForCondition(
          { node_visible: { role: 'button', name: 'Sign On' } }, surface, 5000,
        );
        if (!atLogin.ok) evidence.event('reauth_no_login_screen', { url: atLogin.obs.url });
        for (const id of active.auth?.loginStepIds ?? []) {
          const ls = active.steps.find((x) => x.id === id);
          if (!ls) continue;
          try {
            await runStepOnce(ls);
            evidence.event('reauth_step', { stepId: ls.id, action: ls.action });
          } catch (e) {
            // A failed re-login must not be silent: it turns into a confusing
            // timeout three steps later instead of the honest "we could not sign
            // back in" that it actually is.
            evidence.event('reauth_step_failed', { stepId: ls.id, error: String((e as Error).message).slice(0, 200) });
          }
        }
        // Settle: the sign-on POST redirects into the frameset, and restarting
        // the flow before that lands means the next step polls a page that is
        // still on its way out.
        await waitForCondition({ node_visible: { role: 'link', name: 'Member Search' } }, surface, 8000);
      }
      traces.push({ signalId: s.id, action: r.do, attempt: used + 1, outcome: r.then === 'continue' ? 'continued' : 'retried' });
      evidence.event('recovery_done', { signal: s.id, action: r.do, then: r.then });
      if (r.then === 'restart') return { kind: 'restart', traces };
      if (r.then === 'continue') return { kind: 'continue', traces };
      return { kind: 'recovered', traces };
    }

    return { kind: 'none' };
  }

  /**
   * Poll for a condition and the signal list TOGETHER.
   *
   * Waiting for a checkpoint and only then asking "was there an error?" means a
   * legitimate business outcome costs the full step timeout to discover -- 10
   * seconds to learn that a member does not exist. Racing them makes the answer
   * arrive as soon as the app has one, and it also fixes a correctness race: a
   * signal check fired immediately after a click can look at the page the click
   * is still navigating away from.
   */
  type Settled =
    | { kind: 'condition'; obs: Observation }
    | { kind: 'signal'; verdict: SignalVerdict }
    | { kind: 'timeout'; obs: Observation };

  async function pollUntil(
    cond: Condition | undefined, step: Step, phase: 'pre' | 'post', timeoutMs: number, trace: StepTrace,
  ): Promise<Settled> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const obs = await surface.observe();
      const pool = signalsForStep(active, step.id);
      const hits = await matchSignals(pool, obs, surface);
      if (hits.length) {
        const verdict = await handleSignals(step, phase, obs);
        if (verdict.kind === 'continue') {
          // Cleared an obstruction that was merely in the way. Keep waiting for
          // the original condition rather than repeating the action.
          trace.recoveries.push(...verdict.traces);
          trace.status = 'recovered';
          if (Date.now() >= deadline) return { kind: 'timeout', obs };
          continue;
        }
        return { kind: 'signal', verdict };
      }
      if (!cond) return { kind: 'condition', obs };
      if (await evaluateCondition(cond, obs, surface)) return { kind: 'condition', obs };
      if (Date.now() >= deadline) return { kind: 'timeout', obs };
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // ---- a single act, no ladder. Used by login replay inside reauth.

  async function runStepOnce(step: Step): Promise<void> {
    if (step.action === 'assert') return;
    const obs = await surface.observe();
    if (!step.target) return;
    const res = await resolveLocator(step.target, obs, surface, { allowCoordinateFallback: policy.allowCoordinateFallback });
    if (!res.ok) throw new Error(res.detail);
    const value = resolveValue(step.value, values, redactor);
    const act = step.action === 'click' ? { kind: 'click' as const, ref: res.ref }
      : step.action === 'type' ? { kind: 'type' as const, ref: res.ref, value }
      : step.action === 'select' ? { kind: 'select' as const, ref: res.ref, value }
      : { kind: 'press' as const, key: value || 'Enter', ref: res.ref };
    await (broker ? broker.withControl(() => surface.act(act)) : surface.act(act));
  }

  // ---- the step ladder

  // Index-driven rather than for-of, because a session-expiry recovery has to be
  // able to rewind the cursor to the first non-login step.
  const firstNonLogin = Math.max(
    0,
    ...active.steps.map((s, i) => ((active.auth?.loginStepIds ?? []).includes(s.id) ? i + 1 : 0)),
  );
  let restarts = 0;

  for (let cursor = 0; cursor < active.steps.length; cursor++) {
    const step = active.steps[cursor]!;
    const st0 = Date.now();
    const trace: StepTrace = { stepId: step.id, action: step.action, status: 'ok', ms: 0, recoveries: [] };
    steps.push(trace);

    if (steps.length > policy.maxSteps) {
      return fromHalt({ kind: 'failed', class: 'timeout', stepId: step.id,
        message: `step budget exceeded (${policy.maxSteps})`, expected: `<= ${policy.maxSteps} steps`, observed: `${steps.length}` });
    }
    if (Date.now() - t0 > policy.maxRuntimeMs) {
      return fromHalt({ kind: 'failed', class: 'timeout', stepId: step.id,
        message: `run budget exceeded (${policy.maxRuntimeMs}ms)`, expected: `<= ${policy.maxRuntimeMs}ms`, observed: `${Date.now() - t0}ms` });
    }

    const halt = await executeStep(step, trace);
    trace.ms = Date.now() - st0;
    if (halt === 'restart') {
      if (++restarts > 2) {
        return fromHalt({ kind: 'failed', class: 'session_lost', stepId: step.id,
          message: 'the session was re-established but the flow could not be restarted cleanly',
          expected: 'a stable authenticated session', observed: `${restarts} restarts` });
      }
      evidence.event('flow_restart', { fromStep: step.id, resumeAt: active.steps[firstNonLogin]?.id, attempt: restarts });
      cursor = firstNonLogin - 1;
      continue;
    }
    if (halt) return fromHalt(halt);
  }

  // ---- capability checkpoint, then outputs

  const cpWait = await waitForCondition(active.checkpoint, surface, 8000);
  if (!cpWait.ok) {
    const png = await shot('checkpoint-failed');
    const snap = evidence.snapshot('checkpoint-failed', cpWait.obs.nodes);
    evidence.event('checkpoint_failed', { scope: 'capability' });
    return done({
      status: 'failed',
      error: {
        class: 'checkpoint_failed', stepId: '(capability checkpoint)',
        message: 'all steps ran but the capability success condition was not met',
        expected: describeCondition(active.checkpoint),
        observed: cpWait.obs.text.slice(0, 400).replace(/\s+/g, ' '),
        evidence: { screenshot: png, snapshot: snap },
      },
    });
  }

  const outputs: Record<string, unknown> = {};
  const obs = cpWait.obs;
  for (const o of active.outputs) {
    const res = await resolveLocator(o.from, obs, surface, { allowCoordinateFallback: policy.allowCoordinateFallback });
    if (!res.ok) {
      return done({
        status: 'failed',
        error: {
          class: 'output_extraction_failed', stepId: `(output ${o.name})`,
          message: `could not locate the "${o.name}" value on the success screen`,
          expected: o.from.description, observed: res.detail,
          evidence: { screenshot: await shot(`output-missing-${o.name}`) },
        },
      });
    }
    const raw = (await surface.read(res.ref, o.extract, o.attr))?.trim() ?? '';
    // The declared pattern is an assertion, not decoration: an extracted value
    // that does not match its shape is a failure, never a silently wrong answer
    // handed back to a banking agent.
    if (o.pattern && !new RegExp(o.pattern).test(raw)) {
      return done({
        status: 'failed',
        error: {
          class: 'output_extraction_failed', stepId: `(output ${o.name})`,
          message: `extracted "${o.name}" did not match its declared shape`,
          expected: `/${o.pattern}/`, observed: redactor.redact(raw),
          evidence: { screenshot: await shot(`output-bad-${o.name}`) },
        },
      });
    }
    outputs[o.name] = o.type === 'number' ? Number(raw.replace(/[^0-9.\-]/g, '')) : raw;
  }

  await shot('success');
  const ranks = steps.map((s) => s.strategy?.rank).filter((r): r is number => r !== undefined);
  evidence.event('replay_success', {
    outputs: Object.keys(outputs),
    meanStrategyRank: ranks.length ? +(ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2) : undefined,
  });
  return done({ status: 'success', outputs });


  // ---- the per-step ladder, closed over the run

  async function executeStep(step: Step, trace: StepTrace): Promise<Halt | 'restart' | null> {
    let verifyOnly = false;
    for (let attempt = 0; attempt <= step.retries + 1; attempt++) {
      // A handoff may already have produced the state this step was reaching
      // for. Verify rather than redo: re-running the action is usually wrong,
      // because the control it clicks is exactly the one the operator just
      // consumed on their way out of the problem.
      if (verifyOnly) {
        verifyOnly = false;
        if (!step.checkpoint) { trace.status = 'recovered'; return null; }
        const v = await pollUntil(step.checkpoint, step, 'post', 8000, trace);
        if (v.kind === 'condition') {
          evidence.event('handoff_verified', { stepId: step.id, checkpoint: describeCondition(step.checkpoint) });
          trace.status = 'recovered';
          return null;
        }
        // The operator's word is a claim, not proof. If the app disagrees, we
        // go straight back to them rather than carrying on hopefully.
        evidence.event('handoff_unverified', { stepId: step.id, checkpoint: describeCondition(step.checkpoint) });
        const again = await onStuck(step, trace, 'checkpoint_failed',
          `${describeCondition(step.checkpoint)} (asserted after the operator handed control back)`,
          v.kind === 'timeout' ? v.obs.text.slice(0, 300).replace(/\s+/g, ' ') : 'a signal fired instead');
        if (again === 'verify') { verifyOnly = true; continue; }
        if (again === 'retry') continue;
        if (again === 'skip') { trace.status = 'skipped'; return null; }
        return again;
      }

      // 1+2. Wait for the precondition and watch for signals at the same time.
      //      The previous step may have landed us somewhere unexpected, and that
      //      is discovered here rather than by acting blindly.
      const pre = await pollUntil(step.waitFor, step, 'pre', step.timeoutMs, trace);
      if (pre.kind === 'signal') {
        const v = pre.verdict;
        if (v.kind === 'halt') return v.halt;
        if (v.kind === 'restart') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; return 'restart'; }
        if (v.kind === 'recovered' || v.kind === 'continue') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; }
        continue;
      }
      if (pre.kind === 'timeout') {
        const esc = await onStuck(step, trace, 'timeout',
          `waiting for: ${describeCondition(step.waitFor!)}`, pre.obs.text.slice(0, 300).replace(/\s+/g, ' '));
        if (esc === 'verify') { verifyOnly = true; continue; }
        if (esc === 'retry') continue;
        if (esc === 'skip') { trace.status = 'skipped'; return null; }
        return esc;
      }
      const obs = pre.obs;

      if (step.action === 'assert') { trace.status = 'ok'; break; }

      // 3. resolve
      let ref: string | null = null;
      if (step.target) {
        const res = await resolveLocator(step.target, obs, surface, {
          allowCoordinateFallback: policy.allowCoordinateFallback,
        });
        if (res.ok) {
          ref = res.ref;
          trace.strategy = { kind: res.kind, rank: res.rank, drift: res.rank > step.target.recordedRank };
          if (res.rank > step.target.recordedRank) {
            flags.push({ kind: 'locator_drift', stepId: step.id, recordedRank: step.target.recordedRank, actualRank: res.rank });
            evidence.event('locator_drift', { stepId: step.id, recorded: step.target.recordedRank, actual: res.rank, kind: res.kind });
          }
        } else {
          evidence.event('locator_unresolved', { stepId: step.id, reason: res.reason, tried: res.tried, detail: res.detail });
          const repaired = await tryRepair(step, trace, obs, res.detail);
          if (repaired) { ref = repaired; }
          else {
            const cls: ErrorClass = res.reason === 'ambiguous' ? 'ambiguous_locator'
              : res.reason === 'guard_mismatch' ? 'guard_mismatch' : 'locator_not_found';
            const esc = await onStuck(step, trace, cls, step.target.description, res.detail);
            if (esc === 'verify') { verifyOnly = true; continue; }
            if (esc === 'retry') continue;
            if (esc === 'skip') { trace.status = 'skipped'; return null; }
            return esc;
          }
        }
      }

      // 4. policy, with the control's own name in hand
      const controlName = obs.nodes.find((n) => n.ref === ref)?.name ?? step.target?.description;
      const action = buildAction(step, ref);
      const decision = assertAllowed(action, { policy, risk: step.risk, controlName, currentUrl: obs.url });

      if (decision.effect === 'block') {
        evidence.event('blocked_by_policy', { rule: decision.rule, detail: decision.detail, stepId: step.id });
        await shot(`blocked-${step.id}`);
        return { kind: 'blocked', rule: decision.rule, detail: decision.detail, stepId: step.id };
      }

      if (decision.effect === 'confirm') {
        const r = await escalate({
          runId, capabilityId: active.id, capabilityVersion: active.version,
          stepId: step.id, stepIntent: step.intent, reason: 'confirm_risky',
          summary: `${step.intent} -- ${decision.detail}`,
          url: obs.url,
          aboutToSubmit: {
            capability: `${active.id}@${active.version}`,
            control: controlName ?? '(unnamed)',
            risk: step.risk,
            ...Object.fromEntries(
              active.inputs.map((p) => [p.name, p.sensitivity === 'none' ? (values[p.name] ?? '') : `⟪${p.sensitivity}⟫`]),
            ),
          },
        });
        if (!r) {
          return { kind: 'blocked', rule: decision.rule, stepId: step.id,
            detail: `${decision.detail}, and no operator channel is attached to this run` };
        }
        if (r.resolution === 'reject') {
          return { kind: 'escalated', id: r.id, reason: 'confirm_risky', resolution: 'reject', operator: r.operator, note: r.note };
        }
      }

      if (step.risk !== 'safe') {
        // Always surfaced. "We did the dangerous thing" must never be silent,
        // even when policy said it was fine.
        flags.push({ kind: 'risky_action_allowed', stepId: step.id, risk: step.risk });
        evidence.event('risky_action', { stepId: step.id, risk: step.risk, control: controlName, response: decision.effect });
      }

      // 5. act
      try {
        await (broker ? broker.withControl(() => surface.act(action)) : surface.act(action));
        evidence.event('acted', { stepId: step.id, action: step.action, control: controlName,
          value: step.value && typeof step.value === 'object' && '$secret' in step.value ? '⟪secret⟫' : undefined });
      } catch (e) {
        const esc = await onStuck(step, trace, 'internal', `${step.action} on ${controlName}`, String((e as Error).message).slice(0, 300));
        if (esc === 'verify') { verifyOnly = true; continue; }
        if (esc === 'retry') continue;
        if (esc === 'skip') { trace.status = 'skipped'; return null; }
        return esc;
      }

      // 6+7. Did it work, or did something else happen? Raced, so a business
      //      outcome is reported the moment the app produces it rather than
      //      after the checkpoint has exhausted its timeout.
      const post = await pollUntil(step.checkpoint, step, 'post', step.timeoutMs, trace);
      if (post.kind === 'signal') {
        const v = post.verdict;
        if (v.kind === 'halt') return v.halt;
        if (v.kind === 'restart') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; return 'restart'; }
        if (v.kind === 'recovered' || v.kind === 'continue') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; }
        continue;
      }
      if (post.kind === 'timeout') {
        evidence.event('checkpoint_failed', { stepId: step.id, expected: describeCondition(step.checkpoint!) });
        const esc = await onStuck(step, trace, 'checkpoint_failed',
          describeCondition(step.checkpoint!), post.obs.text.slice(0, 300).replace(/\s+/g, ' '));
        if (esc === 'verify') { verifyOnly = true; continue; }
        if (esc === 'retry') continue;
        if (esc === 'skip') { trace.status = 'skipped'; return null; }
        return esc;
      }
      return null;
    }

    return { kind: 'failed', class: 'internal', stepId: step.id,
      message: `step exhausted ${step.retries + 1} attempt(s)`, expected: step.intent, observed: 'no attempt succeeded' };
  }

  function buildAction(step: Step, ref: string | null) {
    const value = resolveValue(step.value, values, redactor);
    switch (step.action) {
      case 'navigate': return { kind: 'navigate' as const, url: step.url ?? active.surface.entryUrl };
      case 'click': return { kind: 'click' as const, ref: ref! };
      case 'type': return { kind: 'type' as const, ref: ref!, value };
      case 'select': return { kind: 'select' as const, ref: ref!, value };
      default: return { kind: 'press' as const, key: value || 'Enter', ref: ref ?? undefined };
    }
  }

  /**
   * Bounded, policy-checked, single-step locator repair.
   *
   * The model may return a replacement LOCATOR and nothing else. It cannot change
   * the action, the value, the order, or the risk class -- only where this one
   * step points. That containment is what lets replay still be called
   * deterministic: the set of things that can happen is fixed by the artifact,
   * and repair only re-answers "which control".
   */
  async function tryRepair(step: Step, trace: StepTrace, obs: Awaited<ReturnType<Surface['observe']>>, why: string): Promise<string | null> {
    if (!policy.assistedRecovery) return null;
    if (step.risk !== 'safe') { evidence.event('repair_declined', { stepId: step.id, reason: `risk=${step.risk}` }); return null; }
    if (repairsUsed >= policy.assistedRecoveryBudget.perRun) {
      evidence.event('repair_declined', { stepId: step.id, reason: 'run budget exhausted' });
      return null;
    }
    repairsUsed++;
    evidence.event('repair_attempt', { stepId: step.id, why });
    const { repairLocator } = await import('./repair.js');
    const out = await repairLocator({ step, obs, why, capability: active }).catch((e) => {
      evidence.event('repair_error', { stepId: step.id, error: String((e as Error).message).slice(0, 200) });
      return null;
    });
    if (!out) return null;
    const res = await resolveLocator(out.locator, obs, surface, { allowCoordinateFallback: policy.allowCoordinateFallback });
    if (!res.ok) { evidence.event('repair_rejected', { stepId: step.id, detail: res.detail }); return null; }
    trace.status = 'repaired';
    trace.repair = { from: step.target?.description ?? '(none)', to: out.locator.description, model: out.model };
    flags.push({ kind: 'assisted_repair', stepId: step.id });
    evidence.event('repair_applied', { stepId: step.id, strategy: res.kind, rationale: out.rationale });
    // Filed for a human, never silently written back into the artifact.
    evidence.snapshot(`proposed-patch-${step.id}`, {
      capability: `${active.id}@${active.version}`, stepId: step.id,
      replaceTarget: out.locator, rationale: out.rationale, model: out.model,
    });
    return res.ref;
  }

  /** Last resort before failing: ask a human, if there is one. */
  async function onStuck(
    step: Step, trace: StepTrace, cls: ErrorClass, expected: string, observed: string,
  ): Promise<'retry' | 'skip' | 'verify' | Halt> {
    const png = await shot(`stuck-${step.id}`);
    if (!broker) {
      trace.status = 'failed';
      return { kind: 'failed', class: cls, stepId: step.id,
        message: `step "${step.id}" could not proceed: ${step.intent}`, expected, observed };
    }
    const r = await escalate({
      runId, capabilityId: active.id, capabilityVersion: active.version,
      stepId: step.id, stepIntent: step.intent, reason: 'stuck',
      summary: `Automation is stuck on "${step.intent}".`,
      expected, observed, url: (await surface.observe()).url, screenshot: png,
    });
    if (!r) {
      trace.status = 'failed';
      return { kind: 'failed', class: cls, stepId: step.id, message: step.intent, expected, observed };
    }
    if (r.resolution === 'abort') {
      trace.status = 'failed';
      return { kind: 'escalated', id: r.id, reason: 'stuck', resolution: 'abort', operator: r.operator, note: r.note };
    }
    if (r.resolution === 'skip_step') { trace.note = `operator completed this step manually: ${r.note ?? ''}`.trim(); return 'skip'; }
    if (r.resolution === 'retry_step') { trace.note = 'operator asked for a retry'; return 'retry'; }
    // 'resume' means the human has already brought the session to the state this
    // step was trying to reach. Re-running the ACTION would be wrong -- the
    // control it clicks is typically gone, which is how the operator got here.
    // So we verify instead of repeating: re-assert this step's own checkpoint,
    // and only accept the handoff if the app agrees the state is right. The
    // operator's word is taken as a claim, not as proof.
    trace.note = `operator resumed: ${r.note ?? ''}`.trim();
    return 'verify';
  }

  } catch (e) {
    const err = e as Error;
    evidence.event('internal_error', { message: String(err?.message).slice(0, 400), stack: String(err?.stack).slice(0, 1200) });
    const png = await shot('internal-error').catch(() => undefined);
    return done({
      status: 'failed',
      error: {
        class: 'internal',
        stepId: steps[steps.length - 1]?.stepId ?? '(entry)',
        message: `the replay engine raised: ${String(err?.message).slice(0, 300)}`,
        expected: 'the engine to complete the flow or report a handled outcome',
        observed: String(err?.name ?? 'Error'),
        evidence: { screenshot: png },
      },
    });
  }
}

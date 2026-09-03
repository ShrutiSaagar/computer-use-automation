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
import { validateInputs, resolveValueExpr, type InputCheck } from './contract.js';
import { loadSkills, synthesizeSessionCheck, type LoadedSkill } from './skills.js';
import {
  buildStaticPreflight, addCheck, firstGateFailure, finalizeVerdict, type PreflightReport,
} from './preflight.js';

// Re-exported for the callers that imported these from the engine before the
// contract moved to its own module.
export { validateInputs };
export type { InputCheck };

export type ReplayDeps = {
  surface: Surface;
  policy: Policy;
  redactor: Redactor;
  evidence: Evidence;
  /** Absent means escalation is impossible; a stuck run then fails rather than
   *  hanging forever waiting for an operator who is not there. */
  broker?: SessionBroker;
  overlay?: TenantOverlay;
  /** The resolved `uses` graph (loaded before the browser opens). Absent means
   *  load it from the artifact store here. */
  skills?: Map<string, LoadedSkill>;
  skillProblems?: string[];
  skillOrder?: string[];
  /** Audit attribution. */
  invokedBy?: string;
  idempotencyKey?: string;
  /** Composition depth: 0 for a top-level run, +1 per delegated skill. */
  depth?: number;
  /** Evidence scope label for a delegated skill's events. */
  scope?: string;
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
      // A skipped step no longer exists for this tenant, so neither do its conditions.
      ...(patch.skip ? { action: 'assert' as const, target: undefined, waitFor: undefined, checkpoint: undefined } : {}),
    };
  });
  // Renaming controls is the most common per-tenant difference, and the
  // session check asserts on control names -- so the tenant can override it
  // like anything else (and impose one on an artifact that has none yet).
  const requires = overlay.session?.check
    ? {
        ...cap.requires,
        session: {
          ...(cap.requires?.session ?? {}),
          check: overlay.session.check,
          onNotMet: cap.requires?.session?.onNotMet ?? ('establish' as const),
        },
        data: cap.requires?.data ?? [],
      }
    : cap.requires;
  return {
    cap: {
      ...cap,
      surface: {
        ...cap.surface,
        entryUrl: overlay.entryUrl ?? cap.surface.entryUrl,
        ...(overlay.deployment ? { deployment: overlay.deployment } : {}),
      },
      steps,
      checkpoint: rebase(cap.checkpoint),
      outputs: rebase(cap.outputs),
      // Overlay signals are prepended so a tenant-specific rule wins a tie
      // against the product default.
      signals: [...overlay.addSignals, ...rebase(cap.signals)],
      ...(requires ? { requires: rebase(requires) } : {}),
      ...(overlay.post?.condition
        ? { post: { describe: cap.post?.describe, condition: overlay.post.condition } }
        : cap.post ? { post: rebase(cap.post) } : {}),
    },
    touched,
  };
}

// ---------------------------------------------------------------- contract

/** Resolve a value expression against the run's inputs, secrets via the redactor. */
function resolveValue(expr: ValueExpr | undefined, values: Record<string, string>, redactor: Redactor): string {
  return resolveValueExpr(expr, values, (ref) => resolveSecretExpr(ref, redactor));
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
  const depth = deps.depth ?? 0;
  const scopeLabel = deps.scope;

  // The skill graph is resolved before this point by the wiring (run.ts), so a
  // missing dependency never costs a browser launch. A direct caller gets the
  // load-from-store behaviour instead.
  const graph = deps.skills
    ? { skills: deps.skills, order: deps.skillOrder ?? [...deps.skills].map(([n, s]) => `${n}=${s.source}`), problems: deps.skillProblems ?? [] }
    : loadSkills(cap, { maxDepth: policy.maxCompositionDepth });

  let active = cap;
  if (deps.overlay) {
    const merged = applyOverlay(cap, deps.overlay);
    active = merged.cap;
    flags.push({ kind: 'overlay_applied', tenantId: deps.overlay.tenantId, steps: merged.touched });
    evidence.event('overlay_applied', { tenantId: deps.overlay.tenantId, steps: merged.touched });
  }

  const done = (extra: Partial<ReplayResult>): ReplayResult => {
    persistReport(report.invocation.phase);
    return {
      runId,
      capabilityId: active.id,
      capabilityVersion: active.version,
      tenantId: deps.overlay?.tenantId,
      startedAt,
      durationMs: Date.now() - t0,
      evidenceDir: evidence.dir,
      steps,
      flags,
      ...(deps.invokedBy ? { invokedBy: deps.invokedBy } : {}),
      ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
      ...(graph.order.length ? { skills: graph.order } : {}),
      ...extra,
    } as ReplayResult;
  };

  /**
   * The preflight report. Static checks are computed now; the runtime checks
   * (fingerprint, session, data) fill in on arrival, and the report is
   * rewritten as it evolves so even a refused run explains itself on disk.
   */
  const report: PreflightReport = buildStaticPreflight({
    cap: active,
    policy,
    inputs: rawInputs,
    graph,
    overlay: deps.overlay,
    invokedBy: deps.invokedBy,
    idempotencyKey: deps.idempotencyKey,
  });
  // A delegated skill's report is its own file, so a child never overwrites
  // the parent's. Every result passes through done(), which re-persists the
  // FINAL state of the checks (a failed mid-run re-auth is recorded, not lost).
  const reportFile = scopeLabel ? `preflight-${scopeLabel.replace(/[^\w.-]+/g, '_')}.json` : 'preflight.json';
  const persistReport = (phase: string) => {
    evidence.file(reportFile, JSON.stringify(redactor.redactValue(finalizeVerdict(report, phase)), null, 2));
  };

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
    scope: scopeLabel, depth,
    invokedBy: deps.invokedBy,
    ...(deps.idempotencyKey ? { idempotencyKey: deps.idempotencyKey } : {}),
  });

  // ---- contract gates, before we touch the application at all

  const checked = validateInputs(active, rawInputs);
  if (!checked.ok) {
    evidence.event('invalid_input', { message: checked.message });
    persistReport('static');
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
    persistReport('static');
    return done({ status: 'blocked_by_policy', violation: { rule: 'requireStatus', detail } });
  }

  // ---- preflight, part 1: static gates. A refusal here costs milliseconds,
  //      not a browser, and the report on disk says exactly which condition
  //      was not met.
  {
    const failed = firstGateFailure(report);
    if (failed) {
      evidence.event('preflight_not_ready', { check: failed.name, detail: failed.detail, policyRule: failed.policyRule });
      persistReport('static');
      if (failed.policyRule) {
        return fromHalt({ kind: 'blocked', rule: failed.policyRule, detail: failed.detail ?? failed.name });
      }
      return fromHalt({
        kind: 'failed', class: 'precondition_not_met', stepId: `(preflight ${failed.name})`,
        message: `the conditions to run ${active.id}@${active.version} are not met: ${failed.name}`,
        expected: failed.name === 'skill_graph' ? 'every declared skill resolvable' : failed.name,
        observed: failed.detail ?? 'check failed',
      });
    }
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
    addCheck(report, {
      name: 'entry_allowed', ok: false, gate: true, policyRule: 'allowedOrigins',
      detail: `entry URL ${active.surface.entryUrl} is outside the allowlist`,
    });
    persistReport('arrival');
    return fromHalt({
      kind: 'blocked', rule: 'allowedOrigins',
      detail: `entry URL ${active.surface.entryUrl} is outside the allowlist`,
    });
  }
  addCheck(report, { name: 'entry_allowed', ok: true, gate: true, detail: active.surface.entryUrl });

  // Is this still the software this flow was recorded against? Checked once, on
  // arrival, and only flagged: a tenant that has upgraded ahead of the others is
  // something to notice on the day rather than to refuse work over.
  if (active.product.fingerprint) {
    const fp = await waitForCondition(active.product.fingerprint, surface, 4000);
    addCheck(report, {
      name: 'product_fingerprint', ok: fp.ok, gate: false,
      detail: fp.ok ? describeCondition(active.product.fingerprint) : `NOT ${describeCondition(active.product.fingerprint)}`,
    });
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

  // ---- preflight, part 2: the ready state.
  //
  // "The conditions to run" = an authenticated session (if declared) and the
  // declared business-data preconditions (if any). Checked with the same
  // Condition vocabulary the steps use; established when policy allows; failed
  // fast when they cannot be met. Re-run on restart, because "restart" means
  // "reach the ready state again", not merely "rewind the cursor".
  //
  // The result of a delegated skill run, mapped back into this run's terms.
  type SkillRun =
    | { kind: 'success'; outputs: Record<string, unknown> }
    | { kind: 'business'; code: string; message: string; data: Record<string, string> }
    | { kind: 'failed'; class: ErrorClass; message: string; expected: string; observed: string }
    | { kind: 'blocked'; rule: string; detail: string }
    | { kind: 'escalated'; intervention: Extract<ReplayResult, { status: 'escalated' }>['intervention'] };

  /**
   * Run one declared skill IN THIS RUN'S live session -- same surface, same
   * policy, same redaction chokepoint, same broker. The child gets the full
   * engine (its own preflight, checkpoints, signals, recovery) by recursion,
   * which is exactly the point: a skill is not a weaker kind of run.
   *
   * Depth is capped because composition is a graph, not a rabbit hole.
   */
  async function runSkill(name: string, args: Record<string, unknown>, reason: string): Promise<SkillRun> {
    const entry = graph.skills.get(name);
    if (!entry) {
      return { kind: 'failed', class: 'precondition_not_met', message: `skill "${name}" is not loaded`,
        expected: 'a resolvable uses entry', observed: `no skill named "${name}" in the resolved graph` };
    }
    if (depth + 1 > policy.maxCompositionDepth) {
      return { kind: 'failed', class: 'precondition_not_met',
        message: `skill "${name}" would nest deeper than policy allows (${policy.maxCompositionDepth})`,
        expected: `depth <= ${policy.maxCompositionDepth}`, observed: `depth ${depth + 1}` };
    }
    evidence.event('skill_start', { skill: name, capability: entry.source, reason });
    const child = await replay(entry.cap, args, {
      surface, policy, redactor, evidence, broker,
      skills: graph.skills, skillProblems: [], skillOrder: graph.order,
      invokedBy: deps.invokedBy, idempotencyKey: deps.idempotencyKey,
      depth: depth + 1,
      scope: scopeLabel ? `${scopeLabel}>${name}` : name,
    });
    steps.push(...child.steps.map((s) => ({ ...s, stepId: `${name}:${s.stepId}` })));
    flags.push(...child.flags);
    flags.push({ kind: 'skill_loaded', name, capabilityId: entry.cap.id, version: entry.cap.version });
    evidence.event('skill_done', { skill: name, capability: entry.source, status: child.status });
    switch (child.status) {
      case 'success': return { kind: 'success', outputs: child.outputs };
      case 'business_outcome': return { kind: 'business', code: child.outcome.code, message: child.outcome.message, data: child.outcome.data ?? {} };
      case 'failed': return { kind: 'failed', class: child.error.class, message: child.error.message, expected: child.error.expected, observed: child.error.observed };
      case 'blocked_by_policy': return { kind: 'blocked', rule: child.violation.rule, detail: child.violation.detail };
      case 'escalated': return { kind: 'escalated', intervention: child.intervention };
    }
  }

  /** Merge a child's outputs into this run's parameter scope as `name.field`,
   *  so later declared values can reference what a skill found. */
  const adoptSkillOutputs = (name: string, outputs: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(outputs)) values[`${name}.${k}`] = String(v);
  };

  /**
   * Establish and verify the declared session requirement.
   *
   * Store the REQUIREMENT, never the state: the artifact carries a checkable
   * predicate ("the sign-on control is absent") and how to get there (the auth
   * skill) -- not cookies, not tokens, not a flag. Artifacts from before
   * `requires` existed get their check synthesized from the login steps' own
   * sign-on target, so the 1.0 recordings gain the same gate unchanged.
   */
  async function ensureSession(phase: string): Promise<Halt | null> {
    const sess = active.requires?.session;
    const synth = sess ? null : synthesizeSessionCheck(active);
    const check = deps.overlay?.session?.check ?? sess?.check ?? synth?.check;
    if (!check) return null;

    const establishRef = sess?.establish?.uses;
    const inlineLogin = !establishRef && (active.auth?.loginStepIds.length ?? 0) > 0;
    const describe = sess?.describe ?? synth?.source ?? 'an authenticated session';

    const verify = () => waitForCondition(check, surface, 4000);

    const established = await (async (): Promise<{ ok: boolean; via: string } | { halt: Halt }> => {
      const first = await verify();
      if (first.ok) return { ok: true, via: 'already satisfied' };

      const mode = sess?.onNotMet ?? 'establish';
      evidence.event('precondition_not_met', { requirement: 'session', phase, mode, check: describeCondition(check) });

      if (mode === 'fail') {
        return { halt: {
          kind: 'failed', class: 'precondition_not_met', stepId: '(preflight session)',
          message: `session requirement not met and policy says fail: ${describe}`,
          expected: describeCondition(check),
          observed: first.obs.text.slice(0, 300).replace(/\s+/g, ' '),
        } };
      }
      if (mode === 'escalate') {
        const r = await escalate({
          runId, capabilityId: active.id, capabilityVersion: active.version,
          stepId: '(preflight session)', reason: 'stuck',
          summary: `Session requirement not met before the flow can start: ${describe}`,
          expected: describeCondition(check),
          observed: first.obs.text.slice(0, 300).replace(/\s+/g, ' '),
          url: (await surface.observe()).url, screenshot: await shot('precondition-session'),
        });
        if (!r) {
          return { halt: {
            kind: 'failed', class: 'precondition_not_met', stepId: '(preflight session)',
            message: `session requirement not met and no operator channel is attached: ${describe}`,
            expected: describeCondition(check), observed: 'escalation unavailable',
          } };
        }
        if (r.resolution === 'abort') {
          return { halt: { kind: 'escalated', id: r.id, reason: 'stuck', resolution: 'abort', operator: r.operator, note: r.note } };
        }
        return { ok: false, via: `operator (${r.resolution})` };
      }
      // mode === 'establish' (the default)
      if (establishRef) {
        const r = await runSkill(establishRef, {}, `establish session (${phase})`);
        if (r.kind !== 'success') {
          // The child's own verdict is the honest one: an app crash during
          // sign-on must arrive as surface_error, not be laundered into
          // "precondition not met" -- callers retry those differently.
          if (r.kind === 'failed') {
            return { halt: {
              kind: 'failed', class: r.class, stepId: `(preflight session via ${establishRef})`,
              message: `skill "${establishRef}" failed while establishing the session: ${r.message}`,
              expected: r.expected, observed: r.observed,
            } };
          }
          if (r.kind === 'blocked') {
            return { halt: { kind: 'blocked', rule: r.rule, detail: `while establishing the session via "${establishRef}": ${r.detail}`, stepId: '(preflight session)' } };
          }
          if (r.kind === 'escalated') {
            return { halt: { kind: 'escalated', id: r.intervention.id, reason: r.intervention.reason,
              resolution: r.intervention.resolution, operator: r.intervention.operator, note: r.intervention.note } };
          }
          return { halt: {
            kind: 'failed', class: 'precondition_not_met', stepId: `(preflight session via ${establishRef})`,
            message: `could not establish the session requirement with skill "${establishRef}": ${r.code}`,
            expected: describeCondition(check),
            observed: 'the establishing skill answered with a business outcome',
          } };
        }
        return { ok: false, via: `skill "${establishRef}"` };
      }
      if (inlineLogin) {
        // Legacy path: re-run the artifact's own inline login steps, but with
        // the sign-on screen recognised from the artifact (synthesized from the
        // login click's target) instead of control names hardcoded in the engine.
        await runNavigate(active.surface.entryUrl);
        if (synth) {
          const atLogin = await waitForCondition(synth.loginScreen, surface, 5000);
          if (!atLogin.ok) evidence.event('reauth_no_login_screen', { url: atLogin.obs.url });
        }
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
        // Settle: the sign-on POST redirects into the frameset, and moving on
        // before that lands means the next step polls a page still on its way
        // out. The ARTIFACT's first post-login step knows what the landing
        // screen looks like -- the engine does not need to.
        const firstPost = active.steps.find((x) => !(active.auth?.loginStepIds ?? []).includes(x.id));
        if (firstPost?.waitFor) await waitForCondition(firstPost.waitFor, surface, 8000);
        return { ok: false, via: 'inline login steps' };
      }
      return { halt: {
        kind: 'failed', class: 'precondition_not_met', stepId: '(preflight session)',
        message: `session requirement not met and the artifact declares no way to establish it: ${describe}`,
        expected: describeCondition(check),
        observed: first.obs.text.slice(0, 300).replace(/\s+/g, ' '),
      } };
    })();

    if ('halt' in established) { addCheck(report, { name: 'session', ok: false, gate: true, detail: established.halt.kind === 'failed' ? established.halt.message : 'escalated' }); return established.halt; }

    const second = established.ok ? { ok: true } : await verify();
    if (!second.ok) {
      addCheck(report, { name: 'session', ok: false, gate: true, detail: `still unmet after establishment (${established.via})` });
      return {
        kind: 'failed', class: 'precondition_not_met', stepId: '(preflight session)',
        message: `session requirement still not met after establishment via ${established.via}`,
        expected: describeCondition(check),
        observed: 'condition still false after establishing',
      };
    }

    addCheck(report, {
      name: 'session', ok: true, gate: true,
      detail: established.ok ? describeCondition(check) : `${describeCondition(check)} -- established ${established.via}`,
    });
    if (!established.ok) {
      flags.push({ kind: 'precondition_established', name: 'session', via: established.via, check: describeCondition(check) });
    }
    evidence.event('session_verified', { phase, check: describeCondition(check), established: !established.ok ? established.via : undefined });

    // Audit attribution: read WHO we are acting as, from the app itself. The
    // value is registered for redaction -- evidence proves the identity, it
    // never warehouses it.
    if (sess?.identity) {
      try {
        const obs = await surface.observe();
        const res = await resolveLocator(sess.identity, obs, surface, { allowCoordinateFallback: policy.allowCoordinateFallback });
        if (res.ok) {
          const who = (await surface.read(res.ref, 'text'))?.trim() ?? '';
          if (who) {
            redactor.addSensitive('operator', who, 'identifier');
            evidence.event('session_identity', { operator: who, phase });
          }
        }
      } catch { /* attribution is evidence, not a gate -- never fatal */ }
    }
    return null;
  }

  /** Verify the declared business-data preconditions by invoking the skills
   *  that can check them. A child's honest answer becomes this run's answer. */
  async function ensureData(phase: string): Promise<Halt | null> {
    for (const req of active.requires?.data ?? []) {
      let args: Record<string, string> = {};
      try {
        args = Object.fromEntries(
          Object.entries(req.args).map(([k, expr]) => [k, resolveValue(expr, values, redactor)]),
        );
      } catch (e) {
        return {
          kind: 'failed', class: 'invalid_input', stepId: `(requires ${req.name})`,
          message: `data precondition "${req.name}" references an unknown parameter: ${(e as Error).message}`,
          expected: Object.keys(req.args).join(', '), observed: 'unresolvable argument',
        };
      }
      const r = await runSkill(req.via, args, `verify ${req.name} (${phase})`);
      if (r.kind === 'success') {
        adoptSkillOutputs(req.via, r.outputs);
        addCheck(report, { name: `data.${req.name}`, ok: true, gate: true, detail: `via "${req.via}"` });
        continue;
      }
      if (r.kind === 'business' && req.notMetOutcomes.includes(r.code)) {
        addCheck(report, {
          name: `data.${req.name}`, ok: false, gate: false,
          detail: `${r.code} via "${req.via}" -- ${req.onNotMet === 'propagate' ? 'propagated as the caller\u2019s answer' : `onNotMet=${req.onNotMet}`}`,
        });
        if (req.onNotMet === 'propagate') {
          // A child's legitimate answer is THE ANSWER, not an error. The brief
          // calls conflating these the most common design mistake; composition
          // must not reintroduce it one level up.
          report.verdict = 'resolved_early';
          return { kind: 'business', code: r.code, message: r.message, data: r.data };
        }
        if (req.onNotMet === 'escalate') {
          const h = await escalate({
            runId, capabilityId: active.id, capabilityVersion: active.version,
            stepId: `(requires ${req.name})`, reason: 'stuck',
            summary: `Data precondition "${req.name}" not met (${r.code}); an operator decides whether to continue.`,
            expected: `not ${r.code}`, observed: r.message, url: (await surface.observe()).url,
          });
          if (h && h.resolution !== 'abort') { addCheck(report, { name: `data.${req.name}`, ok: true, gate: true, detail: `operator approved (${h.resolution})` }); continue; }
          return h
            ? { kind: 'escalated', id: h.id, reason: 'stuck', resolution: h.resolution, operator: h.operator, note: h.note }
            : { kind: 'failed', class: 'precondition_not_met', stepId: `(requires ${req.name})`,
                message: `data precondition "${req.name}" not met (${r.code}) and no operator was available`,
                expected: `not ${r.code}`, observed: r.message };
        }
        return { kind: 'failed', class: 'precondition_not_met', stepId: `(requires ${req.name})`,
          message: `data precondition "${req.name}" not met: ${r.code}`,
          expected: `not one of [${req.notMetOutcomes.join(', ')}]`, observed: r.message };
      }
      // Anything else the child returned is either a machinery failure of the
      // check itself, or the application genuinely breaking mid-check. Either
      // way the child's own error CLASS is the honest answer -- "surface_error"
      // from an app crash must not be laundered into "precondition_not_met",
      // because callers retry those differently. It comes back naming the
      // skill that failed, per the composition rule: a dependency's hard
      // failure is the parent's hard failure.
      const why = r.kind === 'business' ? `unexpected outcome ${r.code}`
        : r.kind === 'escalated' ? 'escalated'
        : r.kind === 'blocked' ? `blocked by policy: ${r.detail}`
        : r.message;
      addCheck(report, { name: `data.${req.name}`, ok: false, gate: true, detail: why });
      if (r.kind === 'blocked') {
        return { kind: 'blocked', rule: r.rule, detail: `while verifying "${req.name}" via "${req.via}": ${r.detail}`, stepId: `(requires ${req.name})` };
      }
      if (r.kind === 'escalated') {
        return { kind: 'escalated', id: r.intervention.id, reason: r.intervention.reason,
          resolution: r.intervention.resolution, operator: r.intervention.operator, note: r.intervention.note };
      }
      if (r.kind === 'business') {
        // Not one of the declared "not met" codes, but still the child's honest
        // ANSWER (a PERMISSION_DENIED from the lookup is not a crash of the
        // check). It propagates; demoting an answer to a failure is the
        // mistake this whole taxonomy exists to avoid.
        report.verdict = 'resolved_early';
        return { kind: 'business', code: r.code, data: r.data,
          message: `while verifying "${req.name}" via "${req.via}": ${r.message}` };
      }
      return {
        kind: 'failed', class: r.class, stepId: `(requires ${req.name})`,
        message: `skill "${req.via}" failed while verifying "${req.name}": ${r.message}`,
        expected: r.expected, observed: r.observed,
      };
    }
    return null;
  }

  async function ensureReadyState(phase: string): Promise<Halt | null> {
    const s = await ensureSession(phase);
    if (s) return s;
    return ensureData(phase);
  }

  {
    const halt = await ensureReadyState('initial');
    persistReport(halt ? 'ready-state' : 'ready');
    if (halt) return fromHalt(halt);
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
        // Re-authenticate from the credential REFERENCE, mid-run; the password
        // is fetched from the environment at this moment and never written
        // anywhere. The establishment path is the ARTIFACT'S OWN -- the auth
        // skill, or the recorded inline login steps with the sign-on screen
        // recognized from the artifact -- so the engine hardcodes no control
        // names and any product can declare how its sign-on works.
        await runNavigate(active.surface.entryUrl);
        const s = await ensureSession('reauth');
        if (s) return { kind: 'halt', halt: s };
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

  // The ready state already covered sign-on (established, or found in place),
  // so an artifact whose login is INLINE starts after its login steps -- the
  // same place a restart resumes. Starting at 0 would replay "navigate to the
  // sign-on screen" against a session that is already signed on.
  const sessionGated = Boolean(
    deps.overlay?.session?.check ?? active.requires?.session?.check ?? synthesizeSessionCheck(active)?.check,
  );

  for (let cursor = sessionGated ? firstNonLogin : 0; cursor < active.steps.length; cursor++) {
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
      // Restart means "reach the ready state again", not merely "rewind the
      // cursor": the session was just rebuilt, and any declared data
      // preconditions have to be re-verified before the post-login steps can
      // meaningfully run -- in a composed flow the cursor rewinds to a step
      // that assumes the lookup already happened.
      evidence.event('flow_restart', { fromStep: step.id, resumeAt: active.steps[firstNonLogin]?.id, attempt: restarts });
      const rs = await ensureReadyState(`restart-${restarts}`);
      persistReport('ready-state');
      if (rs) return fromHalt(rs);
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

  // ---- read-back post-condition: the world agrees, not just the screen.
  // A checkpoint proves what the final screen SAYS; this proves the effect is
  // actually there. A capability that hands a banking agent a success it
  // cannot verify is worse than one that fails loudly.
  if (active.post) {
    const cond = deps.overlay?.post?.condition ?? active.post.condition;
    const post = await waitForCondition(cond, surface, 8000);
    if (!post.ok) {
      const png = await shot('postcondition-failed');
      const snap = evidence.snapshot('postcondition-failed', post.obs.nodes);
      evidence.event('postcondition_failed', { describe: active.post.describe });
      return done({
        status: 'failed',
        error: {
          class: 'postcondition_failed', stepId: '(post-condition)',
          message: `the flow reported success but the read-back verification did not hold${
            active.post.describe ? `: ${active.post.describe}` : ''}`,
          expected: describeCondition(cond),
          observed: post.obs.text.slice(0, 400).replace(/\s+/g, ' '),
          evidence: { screenshot: png, snapshot: snap },
        },
      });
    }
    evidence.event('postcondition_verified', { describe: active.post.describe, check: describeCondition(cond) });
  }

  // Label skill-scoped success shots, so a composed run's shared evidence dir
  // says WHO reached their end state.
  await shot(scopeLabel ? `success-${scopeLabel}` : 'success');
  const ranks = steps.map((s) => s.strategy?.rank).filter((r): r is number => r !== undefined);
  evidence.event('replay_success', {
    outputs: Object.keys(outputs),
    meanStrategyRank: ranks.length ? +(ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(2) : undefined,
  });
  return done({ status: 'success', outputs });


  /** Resolve a declared `uses` slot to arguments and run it as a step. */
  async function runInvokeStep(step: Step, trace: StepTrace): Promise<Halt | null> {
    if (!step.uses) {
      return { kind: 'failed', class: 'invalid_input', stepId: step.id,
        message: 'invoke step declares no uses entry', expected: 'step.uses to name a uses slot', observed: 'missing' };
    }
    let args: Record<string, string> = {};
    try {
      args = Object.fromEntries(
        Object.entries(step.args ?? {}).map(([k, expr]) => [k, resolveValue(expr, values, redactor)]),
      );
    } catch (e) {
      return { kind: 'failed', class: 'invalid_input', stepId: step.id,
        message: (e as Error).message, expected: 'resolvable args', observed: 'unknown parameter' };
    }
    evidence.event('invoke_start', { stepId: step.id, skill: step.uses });
    const r = await runSkill(step.uses, args, `step ${step.id}`);
    if (r.kind === 'success') {
      adoptSkillOutputs(step.uses, r.outputs);
      // The step's own checkpoint, if declared, is asserted against the state
      // the child LEFT BEHIND. If it fails we do not re-run the child (it may
      // already have acted); we ask a human, or accept and carry on.
      if (step.checkpoint) {
        const v = await pollUntil(step.checkpoint, step, 'post', step.timeoutMs, trace);
        if (v.kind === 'timeout') {
          evidence.event('checkpoint_failed', { stepId: step.id, expected: describeCondition(step.checkpoint) });
          const esc = await onStuck(step, trace, 'checkpoint_failed',
            describeCondition(step.checkpoint), v.obs.text.slice(0, 300).replace(/\s+/g, ' '));
          if (esc === 'skip') { trace.status = 'skipped'; return null; }
          if (esc === 'retry' || esc === 'verify') return null; // never re-run the child
          return esc;
        }
        if (v.kind === 'signal') {
          const verdict = v.verdict;
          if (verdict.kind === 'halt') return verdict.halt;
          if ('traces' in verdict) trace.recoveries.push(...verdict.traces);
        }
      }
      return null;
    }
    switch (r.kind) {
      case 'business': return { kind: 'business', code: r.code, message: r.message, data: r.data };
      case 'blocked': return { kind: 'blocked', rule: r.rule, detail: r.detail, stepId: step.id };
      case 'escalated':
        return { kind: 'escalated', id: r.intervention.id, reason: r.intervention.reason,
          resolution: r.intervention.resolution, operator: r.intervention.operator, note: r.intervention.note };
      case 'failed':
        return { kind: 'failed', class: r.class, stepId: step.id,
          message: `skill "${step.uses}" failed: ${r.message}`, expected: r.expected, observed: r.observed };
    }
  }

  // ---- the per-step ladder, closed over the run

  async function executeStep(step: Step, trace: StepTrace): Promise<Halt | 'restart' | null> {
    // Delegation is not an act on a control; it runs the child once, above.
    if (step.action === 'invoke') return runInvokeStep(step, trace);
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
      //      An assert acts on nothing, so its checkpoint IS a wait condition:
      //      folded in here rather than silently never evaluated.
      const waitFor = step.action === 'assert' && step.checkpoint
        ? (step.waitFor ? { all: [step.waitFor, step.checkpoint] } : step.checkpoint)
        : step.waitFor;
      const pre = await pollUntil(waitFor, step, 'pre', step.timeoutMs, trace);
      if (pre.kind === 'signal') {
        const v = pre.verdict;
        if (v.kind === 'halt') return v.halt;
        if (v.kind === 'restart') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; return 'restart'; }
        if (v.kind === 'recovered' || v.kind === 'continue') { trace.recoveries.push(...v.traces); trace.status = 'recovered'; }
        continue;
      }
      if (pre.kind === 'timeout') {
        const esc = await onStuck(step, trace, 'timeout',
          `waiting for: ${describeCondition(waitFor!)}`, pre.obs.text.slice(0, 300).replace(/\s+/g, ' '));
        if (esc === 'verify') { verifyOnly = true; continue; }
        if (esc === 'retry') continue;
        if (esc === 'skip') { trace.status = 'skipped'; return null; }
        return esc;
      }
      const obs = pre.obs;

      if (step.action === 'assert') { trace.status = 'ok'; return null; }

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

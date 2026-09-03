/**
 * The preflight gate: are the conditions to run this capability met?
 *
 * Two phases, one report.
 *
 *   STATIC (no browser, milliseconds): the declared skill graph resolves, the
 *   deployment allows this capability's target tier, composition is permitted,
 *   every credential reference in the graph is resolvable, and the risky steps
 *   the caller is about to authorize are named up front.
 *
 *   RUNTIME (on arrival, before step one): the product fingerprint, then the
 *   declared session and business-data requirements -- checked with the same
 *   Condition vocabulary the steps use, established when policy allows, and
 *   failed fast as `precondition_not_met` when they do not.
 *
 * Fail-fast is not merely cheaper. "You cannot run this here, yet" is a
 * different ANSWER from "the flow failed at step 7", and callers write
 * different retry logic for each. The report is persisted into the run's
 * evidence either way, so a refusal carries its own explanation.
 *
 * Verdicts:
 *   ready            every gated check passed
 *   ready_with_flags passed, with things worth noticing (fingerprint drift...)
 *   not_ready        a gated check failed; the run refused
 *   resolved_early   a data precondition PROPAGATED a business outcome as the
 *                    caller's answer -- the honest way to say "the check itself
 *                    produced the result; no steps ran"
 */
import type { Capability, TenantOverlay } from '../schema/capability.js';
import type { Policy } from '../policy/guardrails.js';
import { validateInputs } from './contract.js';
import { synthesizeSessionCheck, type SkillLoad } from './skills.js';

export type PreflightCheck = {
  name: string;
  ok: boolean;
  /** A gated check that fails refuses the run. Non-gated checks only inform. */
  gate: boolean;
  detail?: string;
  /** Set when the failure is a POLICY refusal rather than an unmet precondition. */
  policyRule?: string;
};

export type PreflightReport = {
  capability: string;
  tenantId?: string;
  deployment: string;
  verdict: 'ready' | 'ready_with_flags' | 'not_ready' | 'resolved_early';
  checks: PreflightCheck[];
  /** name=capabilityId@version, load order (parents before children). */
  skills: string[];
  skillProblems: string[];
  invocation: { invokedBy?: string; idempotencyKey?: string; phase: string };
};

export function buildStaticPreflight(args: {
  cap: Capability;
  policy: Policy;
  inputs: Record<string, unknown>;
  graph: SkillLoad;
  overlay?: TenantOverlay;
  invokedBy?: string;
  idempotencyKey?: string;
}): PreflightReport {
  const { cap, policy, inputs, graph, overlay } = args;
  const checks: PreflightCheck[] = [];

  // -- the caller's contract
  const inputCheck = validateInputs(cap, inputs);
  checks.push({
    name: 'inputs',
    ok: inputCheck.ok,
    gate: true,
    detail: inputCheck.ok
      ? `${Object.keys(inputCheck.values).length} input(s) accepted`
      : inputCheck.message,
  });

  // -- lifecycle policy
  const rank = { draft: 0, verified: 1, approved: 2 };
  const statusOk = rank[cap.status] >= rank[policy.requireStatus];
  checks.push({
    name: 'capability_status',
    ok: statusOk,
    gate: true,
    policyRule: statusOk ? undefined : 'requireStatus',
    detail: `"${cap.status}" vs policy "${policy.name}" requiring "${policy.requireStatus}"`,
  });

  // -- which deployment tier the target is, and whether this policy may touch it
  const deployment = overlay?.deployment ?? cap.surface.deployment;
  const deploymentOk = policy.allowedDeployments.includes(deployment);
  checks.push({
    name: 'deployment',
    ok: deploymentOk,
    gate: true,
    policyRule: deploymentOk ? undefined : 'allowedDeployments',
    detail: deploymentOk
      ? `"${deployment}" is allowed by policy "${policy.name}"`
      : `target is "${deployment}" but policy "${policy.name}" allows only [${policy.allowedDeployments.join(', ')}]`,
  });

  // -- the declared skill graph
  checks.push({
    name: 'skill_graph',
    ok: graph.problems.length === 0,
    gate: true,
    detail: graph.problems.length
      ? graph.problems.join('; ')
      : (graph.order.length ? graph.order.join(', ') : 'no skills required'),
  });

  // -- is delegation permitted here at all
  const compositionOk = policy.allowComposition || cap.uses.length === 0;
  checks.push({
    name: 'composition_allowed',
    ok: compositionOk,
    gate: true,
    policyRule: compositionOk ? undefined : 'allowComposition',
    detail: compositionOk
      ? (cap.uses.length ? `${cap.uses.length} skill slot(s) permitted` : 'capability composes nothing')
      : `policy "${policy.name}" does not permit capabilities that delegate to other skills`,
  });

  // -- a tenant overlay is bound to one artifact version, and it does not reach
  //    the skills that artifact composes (per-skill overlays are future work);
  //    silently running those un-overlaid against the recording's origin is the
  //    wrong-institution failure the overlay exists to prevent.
  if (overlay) {
    const a = overlay.appliesTo;
    const bound = a.capabilityId === cap.id && a.capabilityVersion === cap.version;
    checks.push({
      name: 'overlay',
      ok: bound && cap.uses.length === 0,
      gate: true,
      detail: !bound
        ? `overlay "${overlay.tenantId}" applies to ${a.capabilityId}@${a.capabilityVersion}, not ${cap.id}@${cap.version}`
        : cap.uses.length
          ? `overlay "${overlay.tenantId}" would not reach the composed skills [${cap.uses.map((u) => u.name).join(', ')}]; per-skill overlays are not supported yet`
          : `"${overlay.tenantId}" bound to ${cap.id}@${cap.version}`,
    });
  }

  // -- credential health across the whole graph, without reading values anywhere
  const credentialTargets: { label: string; ref?: string }[] = [
    { label: cap.id, ref: cap.auth?.credentialRef },
    ...[...graph.skills.values()].map((s) => ({ label: s.source, ref: s.cap.auth?.credentialRef })),
  ];
  const missingCredentials = credentialTargets.filter((t) => t.ref && !credentialResolvable(t.ref));
  checks.push({
    name: 'credential_refs',
    ok: missingCredentials.length === 0,
    gate: true,
    detail: missingCredentials.length
      ? missingCredentials.map((t) => `${t.label}: ${t.ref} not resolvable from the environment`).join('; ')
      : (credentialTargets.some((t) => t.ref) ? 'all references resolvable (values unread)' : 'no credentials required'),
  });

  // -- what the caller is authorizing, stated before anything acts
  const risky = cap.steps.filter((s) => s.risk !== 'safe')
    .map((s) => `${s.id} (${s.risk} -> policy ${policy.risk[s.risk]})`);
  checks.push({ name: 'risky_steps', ok: true, gate: false, detail: risky.length ? risky.join(', ') : 'none declared' });

  // -- what the runtime phase will still have to verify on arrival
  const sess = cap.requires?.session;
  const synth = !sess ? synthesizeSessionCheck(cap) : null;
  const establishVia = sess?.establish?.uses
    ? `skill "${sess.establish.uses}"`
    : (cap.auth?.loginStepIds.length ? `inline login steps [${cap.auth.loginStepIds.join(', ')}]` : 'no establishment path');
  checks.push({
    name: 'session_requirement',
    ok: true,
    gate: false,
    detail: sess
      ? `declared: ${sess.describe ?? 'a session requirement'}; on not met: ${sess.onNotMet} via ${establishVia}`
      : synth
        ? `synthesized for a 1.0 artifact: ${synth.source}; establishment: ${establishVia}`
        : 'no session requirement declared',
  });
  checks.push({
    name: 'data_requirements',
    ok: true,
    gate: false,
    detail: (cap.requires?.data ?? []).length
      ? (cap.requires?.data ?? []).map((d) => `${d.name} via "${d.via}" (on not met: ${d.onNotMet})`).join(', ')
      : 'none declared',
  });

  return finalizeVerdict({
    capability: `${cap.id}@${cap.version}`,
    tenantId: overlay?.tenantId,
    deployment,
    verdict: 'ready', // recomputed from the checks below
    checks,
    skills: graph.order,
    skillProblems: graph.problems,
    invocation: { invokedBy: args.invokedBy, idempotencyKey: args.idempotencyKey, phase: 'static' },
  }, 'static');
}

/** env:NAME resolvability, checked WITHOUT letting the values escape. */
function credentialResolvable(ref: string): boolean {
  const m = /^env:(.+)$/.exec(ref);
  if (!m) return false;
  return Boolean(process.env[`${m[1]}_USERNAME`] && process.env[`${m[1]}_PASSWORD`]);
}

export function addCheck(report: PreflightReport, check: PreflightCheck): void {
  // Runtime re-checks (a restart re-establishes the ready state) update in
  // place, so the report shows the FINAL state of every condition, not a log.
  const i = report.checks.findIndex((c) => c.name === check.name);
  if (i >= 0) report.checks[i] = check;
  else report.checks.push(check);
}

export function firstGateFailure(report: PreflightReport): PreflightCheck | null {
  return report.checks.find((c) => c.gate && !c.ok) ?? null;
}

export function finalizeVerdict(report: PreflightReport, phase: string): PreflightReport {
  report.invocation.phase = phase;
  if (report.verdict !== 'resolved_early') {
    report.verdict =
      firstGateFailure(report) ? 'not_ready'
      : report.checks.some((c) => !c.ok) ? 'ready_with_flags'
      : 'ready';
  }
  return report;
}

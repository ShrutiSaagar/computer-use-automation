/**
 * Wiring. Assembles a surface, policy, redactor, evidence directory and broker,
 * runs a replay, and persists the result. Shared by the CLI and the catalog so
 * an agent invocation and a command-line invocation take exactly the same path.
 */
import { readFileSync } from 'node:fs';
import { Capability, TenantOverlay } from './schema/capability.js';
import type { ReplayResult } from './schema/result.js';
import { loadPolicy, type Policy } from './policy/guardrails.js';
import { Redactor, resolveCredential } from './policy/redact.js';
import { Evidence } from './evidence/logger.js';
import { WebSurface } from './surface/web.js';
import { SessionBroker } from './hitl/broker.js';
import { replay } from './replay/engine.js';
import { loadSkills } from './replay/skills.js';
import { buildStaticPreflight, firstGateFailure, type PreflightReport } from './replay/preflight.js';

// Artifact storage lives in its own module (no engine imports); re-exported
// here so existing callers keep working unchanged.
export {
  CAPABILITY_DIR,
  SIGNAL_PACK_DIR,
  withProductSignals,
  loadCapability,
  listCapabilities,
  saveCapability,
} from './capabilities/store.js';

export type RunOptions = {
  policyPath?: string;
  overlayPath?: string;
  label?: string;
  headless?: boolean;
  broker?: SessionBroker;
  /** Reuse an already-open surface (the operator console holds one open). */
  surface?: WebSurface;
  /** Audit attribution: who asked for this run. */
  invokedBy?: string;
  /** Caller-supplied idempotency marker, recorded on the result and evidence. */
  idempotencyKey?: string;
};

const readOverlay = (path?: string): TenantOverlay | undefined =>
  path ? TenantOverlay.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;

/** The surface handed to a run the static gate has already refused: the engine
 *  returns before touching it, so no browser is paid for. Anything reaching it
 *  is a bug, and says so. */
const unlaunched = (): WebSurface => new Proxy({} as WebSurface, {
  get: (_t, p) => p === 'close'
    ? async () => {}
    : () => Promise.reject(new Error(`static preflight refused the run; surface.${String(p)} must not be called`)),
});

export async function runReplay(
  cap: Capability,
  inputs: Record<string, unknown>,
  opts: RunOptions = {},
): Promise<{ result: ReplayResult; policy: Policy; preflight?: PreflightReport }> {
  const policy = loadPolicy(opts.policyPath ?? 'policy.dev.yaml');
  const redactor = new Redactor();
  // Register credentials up front so they are scrubbed even from a crash trace.
  if (cap.auth) { try { resolveCredential(cap.auth.credentialRef, redactor); } catch { /* surfaced later */ } }

  const evidence = new Evidence('replay', opts.label ?? cap.id.split('.').pop() ?? 'run', redactor);
  const overlay = readOverlay(opts.overlayPath);

  // Resolve the declared skill graph BEFORE the browser opens: a missing or
  // unmatched dependency is a precondition failure, and precondition failures
  // should be cheap to discover.
  const graph = loadSkills(cap, { maxDepth: policy.maxCompositionDepth });

  const owned = !opts.surface;
  // A static refusal must not cost a browser. The engine re-runs these same
  // gates and produces the structured refusal; this only decides whether a
  // launch is worth paying for.
  const refused = firstGateFailure(buildStaticPreflight({ cap, policy, inputs, graph, overlay })) !== null;
  // Reproduce the recording's conditions. Without this a replay inherits
  // whatever the runner happens to be, and any difference shows up as a mystery
  // locator failure rather than as the environment mismatch it actually is.
  const surface = opts.surface ?? (refused ? unlaunched() : await WebSurface.launch({
    headless: opts.headless ?? true,
    environment: overlay?.environment ?? cap.environment,
  }));
  try {
    const result = await replay(cap, inputs, {
      surface, policy, redactor, evidence, broker: opts.broker, overlay,
      skills: graph.skills,
      skillProblems: graph.problems,
      skillOrder: graph.order,
      invokedBy: opts.invokedBy,
      idempotencyKey: opts.idempotencyKey,
    });
    // What we could not impose, we compare. A different browser build is not a
    // failure, but it is the first thing you want to know when a replay that has
    // worked for months suddenly does not.
    if (cap.environment) {
      const actual = await surface.environment().catch(() => null);
      const want = overlay?.environment ?? cap.environment;
      const checks: [string, string | undefined, string | undefined][] = [
        ['browser', want.browser && `${want.browser.name} ${want.browser.version}`,
                    actual?.browser && `${actual.browser.name} ${actual.browser.version}`],
        ['userAgent', want.userAgent, actual?.userAgent],
      ];
      for (const [field, recorded, got] of checks) {
        if (recorded && got && recorded !== got) {
          result.flags.push({ kind: 'environment_drift', field, recorded, actual: got });
          evidence.event('environment_drift', { field, recorded, actual: got });
        }
      }
    }
    // Persisted evidence is redacted; the value returned to the caller is not.
    // A capability exists to hand data back, but the durable artifact on disk is
    // a regulated-data liability -- so the two are deliberately different.
    evidence.file('result.json', JSON.stringify(redactor.redactValue(result), null, 2));
    return { result, policy };
  } finally {
    if (owned) await surface.close();
  }
}

/**
 * Preflight without a browser: resolve the skill graph and run every check that
 * does not need to observe the application. Answers "are the conditions to run
 * this met?" in milliseconds -- what a calling agent should consult BEFORE it
 * commits to a run, and what an operator runs to see why a capability refuses.
 */
export function preflightOnly(
  cap: Capability,
  inputs: Record<string, unknown>,
  opts: { policyPath?: string; overlayPath?: string; label?: string } = {},
): { report: PreflightReport; policy: Policy } {
  const policy = loadPolicy(opts.policyPath ?? 'policy.dev.yaml');
  const graph = loadSkills(cap, { maxDepth: policy.maxCompositionDepth });
  const report = buildStaticPreflight({
    cap,
    policy,
    inputs,
    graph,
    overlay: readOverlay(opts.overlayPath),
    invokedBy: 'preflight-check',
  });
  // Static preflight never touches the app, so it never carries state that
  // needs redaction -- but it goes through the same write path anyway.
  const redactor = new Redactor();
  const evidence = new Evidence('replay', opts.label ?? `preflight-${cap.id.split('.').pop() ?? 'run'}`, redactor);
  evidence.file('preflight.json', JSON.stringify(redactor.redactValue(report), null, 2));
  return { report, policy };
}

/**
 * Wiring. Assembles a surface, policy, redactor, evidence directory and broker,
 * runs a replay, and persists the result. Shared by the CLI and the catalog so
 * an agent invocation and a command-line invocation take exactly the same path.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Capability, Signal, TenantOverlay } from './schema/capability.js';
import type { ReplayResult } from './schema/result.js';
import { loadPolicy, type Policy } from './policy/guardrails.js';
import { Redactor, resolveCredential } from './policy/redact.js';
import { Evidence } from './evidence/logger.js';
import { WebSurface } from './surface/web.js';
import { SessionBroker } from './hitl/broker.js';
import { replay } from './replay/engine.js';

export const CAPABILITY_DIR = 'capabilities';
export const SIGNAL_PACK_DIR = 'signals';

/**
 * Merge the product's curated signal pack into a capability at load time.
 *
 * Session expiry, maintenance interstitials and app crashes are properties of the
 * VENDOR PRODUCT, not of any one flow -- and a discovery run only ever sees the
 * exceptional states that happened to occur while it was running. Resolving them
 * at load rather than baking them in means that when an operations team learns
 * about a new failure mode, adding one entry to signals/<product>.json upgrades
 * every capability recorded against that product, across every tenant, without
 * re-recording anything.
 *
 * The pack wins collisions: it is curated and shared, whereas a discovered
 * detector was inferred from one run and is usually looser.
 */
export function withProductSignals(cap: Capability): Capability {
  const path = join(SIGNAL_PACK_DIR, `${cap.product.id}.json`);
  if (!existsSync(path)) return cap;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { signals: unknown[]; fingerprint?: unknown };
  const pack = raw.signals.map((s) => Signal.parse(s));
  const norm = (v: string | undefined) => (v ?? '').toLowerCase();
  const packKeys = new Set([...pack.map((s) => norm(s.id)), ...pack.map((s) => norm(s.outcome?.code))].filter(Boolean));
  const own = cap.signals.filter((s) => !packKeys.has(norm(s.id)) && !packKeys.has(norm(s.outcome?.code)));
  return {
    ...cap,
    // The version check belongs to the product, not to any one recording, so it
    // arrives from the same curated file and upgrades every capability at once.
    product: { ...cap.product, fingerprint: cap.product.fingerprint ?? (raw.fingerprint as never) },
    signals: [...pack, ...own],
  };
}

export function loadCapability(spec: string): Capability {
  // "id@version", "id" (latest), or a path to a json file
  if (spec.endsWith('.json') && existsSync(spec)) {
    return withProductSignals(Capability.parse(JSON.parse(readFileSync(spec, 'utf8'))));
  }
  const [id, version] = spec.split('@');
  const dir = join(CAPABILITY_DIR, id!);
  if (!existsSync(dir)) throw new Error(`no capability "${id}" in ${CAPABILITY_DIR}/`);
  const files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
  if (!files.length) throw new Error(`no versions of "${id}" in ${dir}`);
  const pick = version
    ? `v${version}.json`
    : files.sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))[0]!;
  return withProductSignals(Capability.parse(JSON.parse(readFileSync(join(dir, pick), 'utf8'))));
}

export function listCapabilities(): Capability[] {
  if (!existsSync(CAPABILITY_DIR)) return [];
  const out: Capability[] = [];
  for (const id of readdirSync(CAPABILITY_DIR)) {
    try { out.push(loadCapability(id)); } catch { /* skip anything unparseable */ }
  }
  return out;
}

export function saveCapability(cap: Capability): string {
  const dir = join(CAPABILITY_DIR, cap.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `v${cap.version}.json`);
  writeFileSync(path, JSON.stringify(cap, null, 2));
  return path;
}

export type RunOptions = {
  policyPath?: string;
  overlayPath?: string;
  label?: string;
  headless?: boolean;
  broker?: SessionBroker;
  /** Reuse an already-open surface (the operator console holds one open). */
  surface?: WebSurface;
};

export async function runReplay(
  cap: Capability,
  inputs: Record<string, unknown>,
  opts: RunOptions = {},
): Promise<{ result: ReplayResult; policy: Policy }> {
  const policy = loadPolicy(opts.policyPath ?? 'policy.dev.yaml');
  const redactor = new Redactor();
  // Register credentials up front so they are scrubbed even from a crash trace.
  if (cap.auth) { try { resolveCredential(cap.auth.credentialRef, redactor); } catch { /* surfaced later */ } }

  const evidence = new Evidence('replay', opts.label ?? cap.id.split('.').pop() ?? 'run', redactor);
  const overlay = opts.overlayPath
    ? TenantOverlay.parse(JSON.parse(readFileSync(opts.overlayPath, 'utf8')))
    : undefined;

  const owned = !opts.surface;
  // Reproduce the recording's conditions. Without this a replay inherits
  // whatever the runner happens to be, and any difference shows up as a mystery
  // locator failure rather than as the environment mismatch it actually is.
  const surface = opts.surface ?? (await WebSurface.launch({
    headless: opts.headless ?? true,
    environment: overlay?.environment ?? cap.environment,
  }));
  try {
    const result = await replay(cap, inputs, {
      surface, policy, redactor, evidence, broker: opts.broker, overlay,
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

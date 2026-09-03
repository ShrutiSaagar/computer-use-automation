/**
 * The artifact store: where capabilities live on disk and how they load.
 *
 * Broken out of run.ts so the skill loader (replay/skills.ts) can resolve
 * dependency graphs without importing the engine's wiring -- the load path
 * must never depend on the execution path, or composing a run would drag a
 * browser launch into what should be a millisecond-scale check.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Capability, Signal } from '../schema/capability.js';

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

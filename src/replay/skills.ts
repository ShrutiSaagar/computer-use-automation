/**
 * Skill loading: turning a capability's declared `uses` graph into the set of
 * capabilities a replay will actually run.
 *
 * The graph is declared in the artifact and resolved HERE, before a browser
 * opens -- so "the conditions to run this capability" includes "every skill it
 * needs exists, at a version the declaration allows". A missing or unmatched
 * skill is a precondition failure discovered in milliseconds, not a confusing
 * mid-flow crash four minutes in.
 *
 * Three rules keep composition a graph rather than a rabbit hole:
 *   cycles are rejected at load time, not discovered mid-run;
 *   depth is capped (policy.maxCompositionDepth);
 *   every resolution is returned so it can be pinned into the run's evidence.
 *
 * This file contains no engine logic. Replay stays the only place that ACTS;
 * loading only decides WHAT would act.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, UsesRef } from '../schema/capability.js';
import { Capability as CapabilitySchema } from '../schema/capability.js';
import { withProductSignals, CAPABILITY_DIR } from '../capabilities/store.js';

/** A resolved skill: the slot name, the loaded capability, its version, and the
 *  path it was loaded from (for the evidence pin). */
export type LoadedSkill = {
  name: string;
  ref: UsesRef;
  cap: Capability;
  source: string;
};

export type SkillLoad = {
  skills: Map<string, LoadedSkill>;
  /** Load order, parents before children -- informative for the report. */
  order: string[];
  /** Anything that made the graph unrunnable. Non-empty means not ready. */
  problems: string[];
};

/**
 * Parse a version range against the available artifact versions.
 *
 * Supports "*", "^N" (same major, i.e. same N -- artifact versions are single
 * monotonic integers), ">=N", "<N", "N", and space-separated AND lists like
 * ">=1 <3". Unparseable ranges match nothing, loudly.
 */
export function matchVersion(range: string, available: number[]): number | null {
  const clauses = range.trim().split(/\s+/).filter(Boolean);
  if (!clauses.length) return null;
  const candidates = [...available].sort((a, b) => b - a); // prefer the newest
  for (const v of candidates) {
    let ok = true;
    for (const c of clauses) {
      if (c === '*' || c === 'latest') continue;
      const m = /^(\^|>=|<=|>|<|=)?(\d+)$/.exec(c);
      if (!m) return null; // unparseable clause: match nothing, say so
      const op = m[1] ?? '=';
      const n = Number(m[2]);
      ok &&=
        op === '=' ? v === n
        : op === '^' ? v === n
        : op === '>=' ? v >= n
        : op === '<=' ? v <= n
        : op === '>' ? v > n
        : v < n;
    }
    if (ok) return v;
  }
  return null;
}

export type SkillLoader = (capabilityId: string) => { versions: number[]; load: (v: number) => Capability };

/** Default loader: read artifacts out of capabilities/<id>/v<N>.json. */
export const fsLoader = (dir: string = CAPABILITY_DIR): SkillLoader => (capabilityId: string) => {
  const d = join(dir, capabilityId);
  if (!existsSync(d)) return { versions: [], load: () => { throw new Error(`no capability "${capabilityId}"`); } };
  const versions = readdirSync(d)
    .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return {
    versions,
    load: (v) => withProductSignals(
      CapabilitySchema.parse(JSON.parse(readFileSync(join(d, `v${v}.json`), 'utf8'))),
    ),
  };
};

/**
 * Resolve a capability's transitive `uses` graph.
 *
 * Children are loaded too (a skill may itself compose skills), so the returned
 * map is everything a replay of `root` could possibly need. A cycle, a depth
 * violation, or a missing/unmatched version lands in `problems` with a message
 * precise enough to fix the artifact without opening a debugger.
 */
export function loadSkills(
  root: Capability,
  opts: { load?: SkillLoader; maxDepth?: number } = {},
): SkillLoad {
  const load = opts.load ?? fsLoader();
  const maxDepth = opts.maxDepth ?? 3;
  const skills = new Map<string, LoadedSkill>();
  const order: string[] = [];
  const problems: string[] = [];
  /** The stack of capability ids currently being expanded -- the cycle detector. */
  const expanding = new Set<string>();

  const visit = (uses: UsesRef[], depth: number, via: string) => {
    if (depth > maxDepth) {
      problems.push(`composition deeper than ${maxDepth} at "${via}"`);
      return;
    }
    for (const ref of uses) {
      const bound = skills.get(ref.name);
      if (bound) {
        // The map is flat across the graph (a slot name is the handle a run
        // invokes by), so the same name must mean the same capability everywhere.
        if (bound.cap.id !== ref.capabilityId) {
          problems.push(`slot "${ref.name}" is bound to ${bound.cap.id} but "${via}" declares it as ${ref.capabilityId}`);
        }
        continue;
      }
      if (expanding.has(ref.capabilityId)) {
        problems.push(
          `dependency cycle: "${ref.capabilityId}" is already being loaded (via ${[...expanding].join(' -> ')})`,
        );
        continue;
      }
      expanding.add(ref.capabilityId);
      try {
        const entry = load(ref.capabilityId);
        const version = matchVersion(ref.version, entry.versions);
        if (version === null) {
          problems.push(
            `skill "${ref.name}" (${ref.capabilityId}) has no version matching "${ref.version}"` +
              (entry.versions.length ? `; available: ${entry.versions.sort((a, b) => a - b).join(', ')}` : '; not found'),
          );
          continue;
        }
        const cap = entry.load(version);
        skills.set(ref.name, { name: ref.name, ref, cap, source: `${ref.capabilityId}@${version}` });
        order.push(`${ref.name}=${ref.capabilityId}@${version}`);
        // The child's own dependencies load too, transitively.
        visit(cap.uses, depth + 1, ref.capabilityId);
      } finally {
        expanding.delete(ref.capabilityId);
      }
    }
  };

  // The root itself is "being expanded" while its children load: a child that
  // references the root's capabilityId is a cycle, and must be caught here.
  expanding.add(root.id);
  visit(root.uses, 1, root.id);
  expanding.delete(root.id);
  return { skills, order, problems };
}

/**
 * Derive a session requirement for artifacts that predate `requires` (schema
 * 1.0): "someone is signed on" is visible as the sign-on control being GONE.
 *
 * The sign-on control is the click target of the last login step, so the
 * synthesized check keys on that target's strongest stable identity -- its
 * role+name strategy if it has one, its guard otherwise. The INVERSE of the
 * same fact ("the control is present") is the pre-login screen, which is what
 * the legacy re-auth path waits for before typing credentials.
 */
export function synthesizeSessionCheck(
  cap: Capability,
): { check: ConditionOf; loginScreen: ConditionOf; source: string } | null {
  if (!cap.auth?.loginStepIds.length) return null;
  const last = cap.steps.find((s) => s.id === cap.auth!.loginStepIds[cap.auth!.loginStepIds.length - 1]);
  const strategy = last?.target?.strategies.find((s) => s.kind === 'role_name');
  const role = strategy?.role ?? last?.target?.guard.role;
  const name = strategy && strategy.kind === 'role_name' ? strategy.name : last?.target?.guard.name;
  if (!role) return null;
  const target = name ? { role, name } : { role };
  return {
    // "the sign-on control is absent" == an authenticated session exists.
    check: { node_absent: target },
    // Its mirror is how we recognise the sign-on screen itself.
    loginScreen: { node_visible: target },
    source: `derived from the "${last!.id}" login step's target (${role}${name ? ` "${name}"` : ''})`,
  };
}

type ConditionOf = Capability['checkpoint'];

/**
 * Trace -> Capability.
 *
 * This is deterministic code, not a model call. The model contributed judgement
 * (what the steps meant, which ones mattered, what the inputs and outputs are,
 * how risky each action was); everything mechanical -- locator ladders, frame
 * identity, parameter substitution, checkpoints -- is derived from what we
 * observed while it was happening.
 *
 * And the model's judgement is verified rather than trusted: the step list it
 * returns has to form an unbroken chain through the states we actually recorded,
 * or compilation fails with a message naming the gap.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Capability, Signal, Step, type Condition, type Locator, type ValueExpr } from '../schema/capability.js';
import { buildLadder } from '../replay/locator.js';
import { PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER, type DiscoveryOutcome, type TraceEntry } from './loop.js';

/**
 * Credentials are resolved from a reference at act time; they are never
 * arguments a calling agent supplies. A discovery agent that helpfully declares
 * "operatorPassword" as an input has produced a contract that is both wrong and
 * unsafe, so the compiler removes them rather than asking the prompt to be
 * luckier next time. Invariants belong in code.
 */
function stripCredentialInputs<T extends { example?: string; name: string }>(
  inputs: T[],
): { kept: T[]; removed: string[] } {
  const isCred = (i: T) =>
    (i.example ?? '').includes(USERNAME_PLACEHOLDER) ||
    (i.example ?? '').includes(PASSWORD_PLACEHOLDER) ||
    /^(operator)?(user(name)?|pass(word)?|credential)s?$/i.test(i.name);
  return { kept: inputs.filter((i) => !isCred(i)), removed: inputs.filter(isCred).map((i) => i.name) };
}

/**
 * Strip a parameter's own value out of the capability id.
 *
 * "member.subaccount.openMoneyMarket" describes the run, not the capability:
 * account type is an input, so a caller reading the catalog would think there
 * must be a separate capability per product. Same principle as canonicalising a
 * member id out of a URL.
 */
function canonicaliseId(id: string, exampleValues: string[]): string {
  let out = id;
  for (const v of exampleValues) {
    const squashed = v.replace(/[^a-zA-Z0-9]/g, '');
    if (squashed.length < 4) continue;
    out = out.replace(new RegExp(squashed, 'ig'), '');
  }
  return out.replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '') || id;
}

export class CompileError extends Error {}

/** Roles worth asserting on. A 'generic' appearing proves nothing. */
const CHECKPOINT_ROLES = ['heading', 'button', 'combobox', 'link', 'cell', 'textbox'];

const sameFrames = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const va = Object.values(a).sort().join('|');
  const vb = Object.values(b).sort().join('|');
  return va === vb;
};

/**
 * Turn a concrete URL into a pattern by replacing the values that came from
 * inputs: /content/member/100482 -> /content/member/[^/]+
 *
 * Without this, every checkpoint would assert on the member id used during
 * discovery, and the capability would only ever work for that one member.
 */
export function canonicaliseUrl(url: string, exampleValues: string[]): string {
  let out = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const v of exampleValues) {
    if (v.length < 2) continue;
    out = out.split(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/?#]+');
  }
  return out;
}

function deriveCheckpoint(entry: TraceEntry, exampleValues: string[]): Condition | undefined {
  const candidate = entry.appeared.find(
    (n) =>
      CHECKPOINT_ROLES.includes(n.role) &&
      n.name.length > 2 && n.name.length < 60 &&
      // Never assert on a value that came from an input: it would pin the
      // capability to the example data it was discovered with.
      !exampleValues.some((v) => v.length > 1 && n.name.includes(v)),
  );
  if (candidate) return { node_visible: { role: candidate.role, name: candidate.name } };

  const before = Object.values(entry.frameUrlsBefore).sort().join('|');
  const after = Object.values(entry.frameUrlsAfter).sort().join('|');
  if (before !== after) {
    const changed = Object.entries(entry.frameUrlsAfter).find(
      ([k, v]) => entry.frameUrlsBefore[k] !== v,
    )?.[1];
    if (changed) return { url_matches: canonicaliseUrl(changed, exampleValues) };
  }
  return undefined;
}

/**
 * Derive the session requirement from the recorded login steps: the sign-on
 * control's strongest stable identity (role+name, else the locator guard)
 * becomes the check -- "that control is absent" is what being signed on looks
 * like from the outside. No engine hardcoding, no model guessing.
 */
function sessionCheckFromLoginSteps(
  steps: { id: string; target?: { strategies: { kind: string; role?: string; name?: string }[]; guard: { role: string; name?: string } } }[],
  loginStepIds: string[],
): { check: { node_absent: { role: string; name?: string } } } | null {
  const last = steps.find((s) => s.id === loginStepIds[loginStepIds.length - 1]);
  const roleStrategy = last?.target?.strategies.find((s) => s.kind === 'role_name');
  const role = roleStrategy?.role ?? last?.target?.guard.role;
  const name = roleStrategy?.name ?? last?.target?.guard.name;
  if (!role) return null;
  return { check: { node_absent: name ? { role, name } : { role } } };
}

export function compile(args: {
  outcome: DiscoveryOutcome;
  goal: string;
  target: string;
  productId: string;
  productVendor: string;
  productVersion: string;
  credentialRef?: string;
  /** Deployment tier the target leads to; recorded on the artifact so policy
   *  can refuse a sandbox recording being pointed at production. */
  deployment?: 'dev' | 'sandbox' | 'uat' | 'prod';
  discoveryRunId: string;
  evidenceDir: string;
  model: string;
  version: number;
  signalPackDir?: string;
}): Capability {
  const { outcome, target, productId, credentialRef } = args;
  const f = outcome.finalize;
  if (!f) throw new CompileError('the discovery run never called finalize_capability, so there is no contract to compile');
  if (!f.steps.length) throw new CompileError('finalize_capability declared no steps');

  const bySeq = new Map(outcome.trace.map((t) => [t.seq, t]));
  const kept: { entry: TraceEntry; intent: string; risk: 'safe' | 'risky' | 'irreversible' }[] = [];
  for (const s of f.steps) {
    const entry = bySeq.get(s.seq);
    if (!entry) throw new CompileError(`finalize_capability referenced seq ${s.seq}, which was never recorded`);
    if (!entry.ok) throw new CompileError(`finalize_capability kept seq ${s.seq}, but that action failed: ${entry.error}`);
    kept.push({ entry, intent: s.intent, risk: s.risk });
  }

  // --- verify the model's pruning instead of trusting it.
  //
  // If the model dropped an action that actually changed the application's
  // state, the surviving steps will not join up: step N+1 expects to start where
  // step N finished. Catching that here produces "your step list has a gap"
  // rather than an artifact that fails confusingly on its first replay.
  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1]!.entry;
    const cur = kept[i]!.entry;
    if (!sameFrames(prev.frameUrlsAfter, cur.frameUrlsBefore)) {
      throw new CompileError(
        `the recorded flow has a gap: step ${i} ("${kept[i]!.intent}") starts at ` +
        `[${Object.values(cur.frameUrlsBefore).join(', ')}] but the previous step ended at ` +
        `[${Object.values(prev.frameUrlsAfter).join(', ')}]. An action that changed the ` +
        `application's state was left out of the step list.`,
      );
    }
  }

  // Every successful action must be accounted for -- kept or explicitly dropped.
  //
  // The frame-URL chain check below catches a dropped NAVIGATION, but a dropped
  // `type` changes no URL and would sail through it, leaving an artifact that
  // submits a form with an empty field. Requiring the model to account for
  // everything closes that hole with an equality check instead of a heuristic.
  const successful = outcome.trace.filter((t) => t.ok).map((t) => t.seq);
  const accounted = new Set([...f.steps.map((s) => s.seq), ...(f.droppedSeqs ?? [])]);
  const unaccounted = successful.filter((n) => !accounted.has(n));
  if (unaccounted.length) {
    const detail = unaccounted
      .map((n) => { const t = bySeq.get(n)!; return `seq ${n} (${t.tool}${t.value !== undefined ? ` "${t.value}"` : ''} -- ${t.why})`; })
      .join('; ');
    throw new CompileError(
      `finalize_capability left ${unaccounted.length} successful action(s) unaccounted for: ${detail}. ` +
      `Every recorded action must appear in steps[] or droppedSeqs.`,
    );
  }

  const { kept: callerInputs, removed: removedInputs } = stripCredentialInputs(f.inputs);
  const exampleValues = callerInputs.map((i) => i.example).filter(Boolean);
  const capabilityId = canonicaliseId(f.id, exampleValues);

  const valueFor = (entry: TraceEntry): ValueExpr | undefined => {
    if (entry.value === undefined) return undefined;
    if (entry.value.includes(USERNAME_PLACEHOLDER)) return { $secret: `${credentialRef ?? 'env:APP_OPERATOR'}.username` };
    if (entry.value.includes(PASSWORD_PLACEHOLDER)) return { $secret: `${credentialRef ?? 'env:APP_OPERATOR'}.password` };
    const param = callerInputs.find((i) => i.example && i.example === entry.value);
    if (param) return { $param: param.name };
    return entry.value;
  };

  const loginStepIds: string[] = [];
  const steps: Step[] = kept.map(({ entry, intent, risk }, i) => {
    const id = `s${i + 1}_${(entry.element?.name || entry.element?.anchorText || entry.tool)
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 18) || entry.tool}`;

    const target_ = entry.element
      ? buildLadder(entry.element, describeControl(entry), entry.frameName, 'action')
      : undefined;

    // Wait for something that proves the control's screen is up. A named control
    // asserts on itself; an unnamed one asserts on the caption beside it, which
    // is the only durable thing about it anyway.
    const waitFor: Condition | undefined = target_?.guard.name
      ? { node_visible: { role: target_.guard.role, name: target_.guard.name } }
      : entry.element?.anchorText
        ? { text_present: entry.element.anchorText }
        : undefined;

    if (entry.value?.includes(USERNAME_PLACEHOLDER) || entry.value?.includes(PASSWORD_PLACEHOLDER)) loginStepIds.push(id);

    return Step.parse({
      id, intent,
      action: entry.tool,
      target: target_,
      value: valueFor(entry),
      url: entry.tool === 'navigate' ? entry.url : undefined,
      risk,
      waitFor,
      checkpoint: deriveCheckpoint(entry, exampleValues),
      timeoutMs: 10_000,
      retries: 1,
      onError: [],
    });
  });

  // The sign-on click itself is part of authentication even though it types
  // nothing, so the reauth recovery has to replay it too.
  const lastCredIdx = steps.findIndex((s) => s.id === loginStepIds[loginStepIds.length - 1]);
  if (lastCredIdx >= 0 && steps[lastCredIdx + 1] && steps[lastCredIdx + 1]!.action === 'click') {
    loginStepIds.push(steps[lastCredIdx + 1]!.id);
  }

  /**
   * Test each declared output pattern against the value we actually extracted.
   *
   * The extracted value is ground truth: we watched the application produce it.
   * A regex that rejects it is provably wrong, and shipping it would make the
   * capability fail on its very first real call with output_extraction_failed --
   * which is a confusing way to learn that a model assumed thousands separators
   * in a currency field that does not use them.
   *
   * Same treatment as a bad outcome detector: drop it and say so. Losing an
   * assertion costs us something we never really had; keeping a wrong one breaks
   * an otherwise working capability.
   */
  const rejectedOutputPatterns: { output: string; pattern: string; value: string }[] = [];
  const outputs = f.outputs.map((o) => {
    const ex = outcome.extractions.find((e) => e.name === o.name);
    if (!ex) throw new CompileError(`finalize_capability declared output "${o.name}" but extract() was never called for it`);
    let pattern = o.pattern;
    if (pattern) {
      let ok = false;
      try { ok = new RegExp(pattern).test(ex.value.trim()); } catch { ok = false; }
      if (!ok) {
        rejectedOutputPatterns.push({ output: o.name, pattern, value: ex.value.trim() });
        pattern = undefined;
      }
    }
    return {
      name: o.name, type: o.type, description: o.description,
      from: buildLadder(ex.element, ex.description || `the ${o.name} value on the final screen`,
        undefined, 'output'),
      extract: 'text' as const,
      pattern,
      sensitivity: (o.sensitivity ?? 'none') as never,
    };
  });

  // Signals come from two places, deliberately -- but only one of them is stored
  // in the artifact. The product pack is loaded here solely so a detector this
  // run rediscovered can be recognised as already covered; it is NOT baked in.
  // See loadProductSignals() in run.ts for why.
  const packPath = join(args.signalPackDir ?? 'signals', `${productId}.json`);
  const productSignals: Signal[] = existsSync(packPath)
    ? (JSON.parse(readFileSync(packPath, 'utf8')).signals as unknown[]).map((s) => Signal.parse(s))
    : [];
  /**
   * Test every declared outcome detector against the screens this run actually
   * visited on its way to success.
   *
   * A business-outcome detector that fires on a happy-path screen is not merely
   * imprecise, it is actively harmful: it turns a working capability into one
   * that reports a fake business outcome and stops. The failure mode is real --
   * the first discovery run produced a "deposit below minimum" regex that matched
   * the "min $25.00" hint text printed permanently beside the field, so it fired
   * the instant the form rendered.
   *
   * We have the text of every screen from the successful run, so this is
   * decidable rather than a matter of prompting harder. Offending detectors are
   * dropped and reported: dropping one can only cost us a detector we never had,
   * whereas keeping one breaks the capability.
   */
  //
   // Scoped to the KEPT steps, not to every screen the run visited. The agent is
   // encouraged to probe one read-only error state before the real flow, so an
   // absent-record screen legitimately appears in the trace -- and validating
   // against the whole trace rejected the correct "no such member" detector for
   // matching the very screen the agent went and looked at on purpose. The
   // compiled flow is the happy path; exploration is in droppedSeqs.
  const happyPathText = kept.map((k) => k.entry.textAfter ?? '');
  const rejectedSignals: { code: string; matched: string }[] = [];
  const discovered: Signal[] = [];
  f.businessOutcomes.forEach((b, i) => {
    let re: RegExp;
    try { re = new RegExp(b.whenTextMatches, 'i'); }
    catch { rejectedSignals.push({ code: b.code, matched: 'not a valid regular expression' }); return; }
    const clash = happyPathText.find((t) => re.test(t));
    if (clash) {
      const m = re.exec(clash);
      rejectedSignals.push({ code: b.code, matched: (m?.[0] ?? '').slice(0, 80) });
      return;
    }
    discovered.push(Signal.parse({
      id: b.code.toLowerCase(), priority: 100 + i, classify: 'business_outcome',
      description: b.description,
      when: { text_matches: b.whenTextMatches },
      outcome: { code: b.code, message: b.message },
    }));
  });

  // Product-level signals win a collision: they are curated and shared across
  // every capability on this product, whereas a discovered one was inferred from
  // a single run and is usually looser. Compared case-insensitively on both id
  // and outcome code, because a model writing "member_not_found" where the pack
  // says "MEMBER_NOT_FOUND" means the same thing and must not produce two
  // detectors that disagree about the same condition.
  const norm = (v: string | undefined) => (v ?? '').toLowerCase();
  const seen = new Set([
    ...productSignals.map((s) => norm(s.id)),
    ...productSignals.map((s) => norm(s.outcome?.code)),
  ].filter(Boolean));
  const keptDiscovered = discovered.filter((s) => !seen.has(norm(s.id)) && !seen.has(norm(s.outcome?.code)));
  const supersededSignals = discovered
    .filter((s) => seen.has(norm(s.id)) || seen.has(norm(s.outcome?.code)))
    .map((s) => s.outcome?.code ?? s.id);

  // A fresh artifact declares its session requirement even though discovery ran
  // while signing on: the compiler derives the check from the recorded login
  // steps themselves (the sign-on control disappearing IS "signed on"), so the
  // replay preflight can verify -- and re-establish -- the session without any
  // control names hardcoded in the engine. Establishment stays inline
  // (loginStepIds) until an auth skill exists for this product to delegate to.
  const sessionCheck = loginStepIds.length
    ? sessionCheckFromLoginSteps(steps, loginStepIds)
    : null;

  return Capability.parse({
    schemaVersion: '1.1',
    id: capabilityId, version: args.version, name: f.name, description: f.description,
    status: 'draft',
    product: { id: productId, vendor: args.productVendor, version: args.productVersion },
    surface: { kind: 'legacy_web', entryUrl: target, deployment: args.deployment ?? 'sandbox' },
    environment: outcome.environment,
    auth: loginStepIds.length ? { credentialRef: credentialRef ?? 'env:APP_OPERATOR', loginStepIds } : undefined,
    ...(sessionCheck
      ? {
          requires: {
            session: {
              describe: 'an authenticated operator session (the sign-on screen is gone)',
              check: sessionCheck.check,
              onNotMet: 'establish',
            },
          },
        }
      : {}),
    inputs: callerInputs.map((i) => ({
      name: i.name, type: i.type, description: i.description, required: true,
      pattern: i.pattern, enum: i.enumValues, sensitivity: i.sensitivity as never, example: i.example,
    })),
    outputs,
    steps,
    // Only the discovered signals. Product-level ones are merged at load time so
    // that curating a new detector improves every capability recorded against
    // this product at once, instead of requiring each to be re-recorded.
    signals: keptDiscovered,
    checkpoint: outputs.length
      ? { all: [{ text_present: f.checkpointText }, { value_matches: { target: outputs[0]!.from, pattern: outputs[0]!.pattern ?? '.+' } }] }
      : { text_present: f.checkpointText },
    provenance: {
      discoveryRunId: args.discoveryRunId, model: args.model,
      recordedAt: new Date().toISOString(), evidenceDir: args.evidenceDir,
      rejectedSignals: rejectedSignals.length ? rejectedSignals : undefined,
      removedCredentialInputs: removedInputs.length ? removedInputs : undefined,
      declaredId: f.id !== capabilityId ? f.id : undefined,
      supersededSignals: supersededSignals.length ? supersededSignals : undefined,
      rejectedOutputPatterns: rejectedOutputPatterns.length ? rejectedOutputPatterns : undefined,
    },
    stats: { replays: 0, successes: 0 },
  });
}

function describeControl(entry: TraceEntry): string {
  const el = entry.element;
  if (!el) return entry.why;
  const what = el.name ? `the "${el.name}" ${el.role}` : `the ${el.role} next to "${el.anchorText}"`;
  return `${what}${entry.frameName ? ` in the ${entry.frameName}` : ''}`;
}

export function inferLocatorDescription(l: Locator): string { return l.description; }

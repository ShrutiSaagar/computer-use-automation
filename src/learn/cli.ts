/**
 * `learn` -- the discovery command.
 *
 * goal + target -> a real LLM run against the live app -> a compiled artifact ->
 * an immediate self-replay that decides whether the artifact is trustworthy.
 *
 * The self-replay is the part worth arguing for. A recording that has never been
 * played back is a guess: the model reached the goal once, with refs that were
 * valid at that instant, and nothing yet says the DURABLE locators we derived
 * will find the same controls on a cold run. Replaying immediately, with the same
 * inputs, is a cheap and total answer -- and it is what promotes the artifact
 * from `draft` to `verified`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Redactor, resolveCredential } from '../policy/redact.js';
import { loadPolicy } from '../policy/guardrails.js';
import { Evidence } from '../evidence/logger.js';
import { WebSurface } from '../surface/web.js';
import { discover } from './loop.js';
import { compile, CompileError } from './compile.js';
import { MODEL } from './model.js';
import { CAPABILITY_DIR, saveCapability, runReplay } from '../run.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function nextVersion(id: string): number {
  const dir = join(CAPABILITY_DIR, id);
  if (!existsSync(dir)) return 1;
  const vs = readdirSync(dir).map((f) => Number(/^v(\d+)\.json$/.exec(f)?.[1] ?? 0));
  return Math.max(0, ...vs) + 1;
}

export async function learnCommand(opts: {
  goal?: string; target?: string; policyPath?: string; headed?: boolean; maxSteps: number;
}): Promise<number> {
  if (!opts.goal || !opts.target) {
    console.error('usage: learn --goal "<natural language goal>" --target <url> [--headed]');
    return 2;
  }
  const policy = loadPolicy(opts.policyPath ?? 'policy.dev.yaml');
  const redactor = new Redactor();
  const credentialRef = process.env.CUA_CREDENTIAL_REF ?? 'env:CU_CORE_OPERATOR';
  let credentials: { username: string; password: string } | undefined;
  try { credentials = resolveCredential(credentialRef, redactor); }
  catch { console.log(C.yellow(`no credentials for ${credentialRef}; the agent will have to manage without`)); }

  const evidence = new Evidence('discovery', 'run', redactor);
  console.log(`${C.bold('learning')}  ${opts.goal}`);
  console.log(C.dim(`  target ${opts.target}   model ${MODEL}   policy ${policy.name}   evidence ${evidence.dir}\n`));

  const surface = await WebSurface.launch({ headless: !opts.headed });
  let outcome;
  try {
    outcome = await discover({
      goal: opts.goal, target: opts.target, surface, policy, redactor, evidence,
      credentials, maxSteps: opts.maxSteps,
    });
  } finally {
    await surface.close();
  }

  // The raw trace is the primary evidence of what the model actually did, as
  // distinct from the artifact, which is what we concluded from it. Keeping both
  // is what makes a compiled step reviewable against the action it came from.
  evidence.json('trace.json', ({
    goal: opts.goal, target: opts.target, model: MODEL,
    turns: outcome.turns, costUsd: outcome.costUsd, blocked: outcome.blocked,
    actions: outcome.trace.map((t) => ({
      seq: t.seq, tool: t.tool, why: t.why, ok: t.ok, error: t.error, value: t.value, url: t.url,
      control: t.element ? { role: t.element.role, name: t.element.name, id: t.element.id, anchorText: t.element.anchorText, frame: t.frameName } : undefined,
      urlAfter: t.urlAfter, appeared: t.appeared.slice(0, 8),
    })),
    extractions: outcome.extractions.map((e) => ({ name: e.name, description: e.description })),
    finalize: outcome.finalize,
  }));

  console.log(`${C.bold('discovery')}  ${outcome.trace.length} actions, ${outcome.turns} turns` +
    (outcome.costUsd ? `, $${outcome.costUsd.toFixed(4)}` : ''));
  for (const b of outcome.blocked) console.log(C.yellow(`  guardrail refused a ${b.tool}: ${b.detail}`));
  if (outcome.error) console.log(C.red(`  ${outcome.error}`));
  if (!outcome.finalize) {
    console.log(C.red('\nthe agent never reached the goal, so there is no capability to compile'));
    console.log(C.dim(`evidence: ${evidence.dir}`));
    return 1;
  }

  let cap;
  try {
    cap = compile({
      outcome, goal: opts.goal, target: opts.target,
      productId: process.env.CUA_PRODUCT_ID ?? 'cucore',
      productVendor: process.env.CUA_PRODUCT_VENDOR ?? 'CU-Core Systems',
      productVersion: process.env.CUA_PRODUCT_VERSION ?? '8.2',
      credentialRef, discoveryRunId: evidence.runId, evidenceDir: evidence.dir,
      model: MODEL, version: nextVersion(outcome.finalize.id),
    });
  } catch (e) {
    if (e instanceof CompileError) {
      console.log(C.red(`\ncompile refused this recording:\n  ${e.message}`));
      evidence.event('compile_failed', { message: e.message });
      return 1;
    }
    throw e;
  }

  console.log(`\n${C.bold('compiled')}  ${cap.id}@${cap.version}  ${cap.steps.length} steps, ` +
    `${cap.inputs.length} inputs, ${cap.outputs.length} outputs, ${cap.signals.length} signals`);
  for (const s of cap.steps) {
    const rank0 = s.target?.strategies[0]?.kind ?? '-';
    console.log(C.dim(`  ${s.id.padEnd(20)} ${s.risk.padEnd(13)} ${rank0.padEnd(11)} ${s.intent.slice(0, 60)}`));
  }

  // ---- self-replay: the difference between "it worked once" and "it replays"
  const inputs = Object.fromEntries(cap.inputs.map((i) => [i.name, i.example ?? '']));
  console.log(`\n${C.bold('verifying')}  replaying the fresh artifact with ${JSON.stringify(inputs)}`);
  const { result } = await runReplay(cap, inputs, {
    policyPath: opts.policyPath, label: 'selfverify', headless: !opts.headed,
  });

  const passed = result.status === 'success';
  cap.status = passed ? 'verified' : 'draft';
  cap.provenance.selfReplay = {
    passed, runId: result.runId,
    error: result.status === 'failed' ? `${result.error.class}: ${result.error.message}` : undefined,
  };
  if (passed) { cap.stats.replays = 1; cap.stats.successes = 1; cap.stats.lastVerifiedAt = new Date().toISOString(); }

  const path = saveCapability(cap);
  evidence.fileRaw('capability.json', JSON.stringify(cap, null, 2));
  evidence.event('compiled', { id: cap.id, version: cap.version, status: cap.status, path });

  if (passed) {
    console.log(`${C.green('  verified')}  the artifact replayed clean; outputs ${JSON.stringify(result.status === 'success' ? result.outputs : {})}`);
  } else {
    console.log(`${C.yellow('  draft')}     self-replay did not pass (${result.status}); saved for review rather than discarded`);
  }
  console.log(`\n${C.bold('saved')}  ${path}   ${C.dim(`status=${cap.status}`)}`);
  console.log(C.dim(`evidence: ${evidence.dir}  (discovery)  ${result.evidenceDir}  (self-replay)\n`));
  return passed ? 0 : 1;
}

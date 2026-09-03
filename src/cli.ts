#!/usr/bin/env node
/**
 * interface-cua
 *
 *   learn    goal + target -> a real LLM run -> a capability artifact
 *   replay   artifact + inputs -> deterministic execution -> a structured result
 *   console  operator console for human takeover of a live session
 *   catalog  expose saved capabilities as callable tools for an AI agent
 *   schema   print the JSON Schema for the artifact format
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Capability } from './schema/capability.js';
import { loadCapability, listCapabilities, runReplay, preflightOnly } from './run.js';
import type { PreflightReport } from './replay/preflight.js';

function printPreflight(r: PreflightReport): void {
  const badge =
    r.verdict === 'ready' ? C.green('READY')
    : r.verdict === 'ready_with_flags' ? C.yellow('READY (WITH FLAGS)')
    : r.verdict === 'resolved_early' ? C.cyan('RESOLVED BY PRECONDITION CHECK')
    : C.red('NOT READY');
  console.log(`\n${badge}  ${C.dim(`${r.capability} · deployment ${r.deployment}${r.tenantId ? ` · tenant ${r.tenantId}` : ''}`)}`);
  console.log(C.bold('\nchecks'));
  for (const c of r.checks) {
    const mark = c.ok ? C.green('ok') : c.gate ? C.red('GATE FAIL') : C.yellow('flag');
    console.log(`  ${mark.padEnd(14)} ${c.name.padEnd(22)} ${C.dim(c.detail ?? '')}`);
  }
  if (r.skills.length) {
    console.log(C.bold('\nskills'));
    for (const s of r.skills) console.log(`  ${s}`);
  }
  console.log('');
}

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

/** --input memberId=100482 --input accountType="Money Market" */
function inputs(): Record<string, string> {
  const out: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== '--input') return;
    const kv = argv[i + 1];
    if (!kv) return;
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  });
  return out;
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function printResult(r: Awaited<ReturnType<typeof runReplay>>['result']): void {
  const badge =
    r.status === 'success' ? C.green('SUCCESS')
    : r.status === 'business_outcome' ? C.yellow('BUSINESS OUTCOME')
    : r.status === 'escalated' ? C.cyan('ESCALATED')
    : r.status === 'blocked_by_policy' ? C.yellow('BLOCKED BY POLICY')
    : C.red('FAILED');

  console.log(`\n${badge}  ${C.dim(`${r.capabilityId}@${r.capabilityVersion} · ${r.durationMs}ms`)}`);

  if (r.status === 'success') {
    console.log(C.bold('\noutputs'));
    for (const [k, v] of Object.entries(r.outputs)) console.log(`  ${k.padEnd(20)} ${v}`);
  } else if (r.status === 'business_outcome') {
    console.log(`\n  ${C.bold(r.outcome.code)}  ${r.outcome.message}`);
    for (const [k, v] of Object.entries(r.outcome.data ?? {})) console.log(`  ${C.dim(k)} ${v}`);
    console.log(C.dim('\n  This is an answer, not a crash. The caller is expected to handle it.'));
  } else if (r.status === 'failed') {
    console.log(`\n  ${C.bold(r.error.class)} at step ${C.bold(r.error.stepId)}`);
    console.log(`  ${r.error.message}`);
    console.log(`  ${C.dim('expected')}  ${r.error.expected}`);
    console.log(`  ${C.dim('observed')}  ${r.error.observed}`);
  } else if (r.status === 'blocked_by_policy') {
    console.log(`\n  rule ${C.bold(r.violation.rule)}: ${r.violation.detail}`);
  } else if (r.status === 'escalated') {
    console.log(`\n  intervention ${r.intervention.id} (${r.intervention.reason}) -> ${C.bold(r.intervention.resolution)}`);
    if (r.intervention.note) console.log(`  ${C.dim('note')} ${r.intervention.note}`);
  }

  console.log(C.bold('\nsteps'));
  for (const s of r.steps) {
    const mark = s.status === 'ok' ? C.green('ok') : s.status === 'failed' ? C.red('fail') : C.yellow(s.status);
    const via = s.strategy ? C.dim(` via ${s.strategy.kind}(rank ${s.strategy.rank})${s.strategy.drift ? ' DRIFT' : ''}`) : '';
    const rec = s.recoveries.length ? C.yellow(` +${s.recoveries.length} recovery`) : '';
    console.log(`  ${mark.padEnd(18)} ${s.stepId.padEnd(14)} ${String(s.ms + 'ms').padStart(7)}${via}${rec}`);
  }
  if (r.flags.length) {
    console.log(C.bold('\nflags'));
    for (const f of r.flags) console.log(`  ${C.yellow(f.kind)} ${JSON.stringify(f)}`);
  }
  if (r.skills?.length) {
    console.log(C.bold('\nskills'));
    for (const s of r.skills) console.log(`  ${s}`);
  }
  if (r.invokedBy || r.idempotencyKey) {
    console.log(C.dim(`\ninvoked by ${r.invokedBy ?? 'unknown'}${r.idempotencyKey ? ` · idempotency key ${r.idempotencyKey}` : ''}`));
  }
  console.log(C.dim(`\nevidence: ${r.evidenceDir}\n`));
}

/** Long-running servers must not fall through to process.exit(). */
const park = (): Promise<number> => new Promise<number>(() => {});

async function main(): Promise<number> {
  switch (cmd) {
    case 'replay': {
      const spec = flag('capability') ?? argv[1];
      if (!spec) { console.error('usage: replay --capability <id[@v]|path.json> --input k=v ...'); return 2; }
      const cap = loadCapability(spec);
      if (has('preflight-only')) {
        // The conditions-to-run check, without a browser: skill graph, policy,
        // credentials. What a calling agent should consult BEFORE committing.
        const { report } = preflightOnly(cap, inputs(), { policyPath: flag('policy'), overlayPath: flag('overlay'), label: flag('label') });
        printPreflight(report);
        return report.verdict === 'ready' || report.verdict === 'ready_with_flags' ? 0 : 1;
      }
      const { result } = await runReplay(cap, inputs(), {
        policyPath: flag('policy'),
        overlayPath: flag('overlay'),
        label: flag('label'),
        headless: !has('headed'),
        invokedBy: flag('invoked-by') ?? 'cli',
        idempotencyKey: flag('idempotency-key'),
      });
      printResult(result);
      return result.status === 'success' || result.status === 'business_outcome' ? 0 : 1;
    }

    case 'list': {
      const caps = listCapabilities();
      if (!caps.length) { console.log('no capabilities recorded yet'); return 0; }
      for (const c of caps) {
        console.log(`${C.bold(`${c.id}@${c.version}`)}  ${C.dim(c.status)}  ${c.name}`);
        console.log(`  ${C.dim(c.description.slice(0, 110))}`);
        console.log(`  ${C.dim('in ')} ${c.inputs.map((i) => `${i.name}:${i.type}`).join(', ') || '(none)'}`);
        console.log(`  ${C.dim('out')} ${c.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}\n`);
      }
      return 0;
    }

    case 'schema': {
      const json = z.toJSONSchema(Capability, { io: 'input' });
      const out = flag('out');
      const text = JSON.stringify(json, null, 2);
      if (out) { writeFileSync(out, text); console.log(`wrote ${out}`); } else console.log(text);
      return 0;
    }

    case 'learn': {
      const { learnCommand } = await import('./learn/cli.js');
      return learnCommand({ goal: flag('goal'), target: flag('target'), policyPath: flag('policy'), headed: has('headed'), maxSteps: Number(flag('max-steps') ?? 40), deployment: flag('deployment') });
    }

    case 'console': {
      const { startConsole } = await import('./hitl/console/server.js');
      await startConsole({ port: Number(flag('port') ?? 7788) });
      return park();
    }

    case 'agent-demo': {
      const { agentDemo } = await import('./catalog/agent-demo.js');
      return agentDemo({
        ask: flag('ask') ?? 'Open a Money Market sub-account for member 100482 with a $50.00 opening deposit, then tell me the new account number.',
        policyPath: flag('policy'), out: flag('out'),
      });
    }

    case 'catalog': {
      const { startCatalog } = await import('./catalog/server.js');
      await startCatalog({ port: Number(flag('port') ?? 7789), policyPath: flag('policy') });
      return park();
    }

    default:
      console.log(`interface-cua

  learn    --goal "<natural language goal>" --target <url> [--headed] [--deployment dev|sandbox|uat|prod]
  replay   --capability <id[@v]|path.json> --input k=v [--policy p.yaml] [--overlay o.json] [--headed]
           [--preflight-only] [--invoked-by who] [--idempotency-key key]
  list     show recorded capabilities and their contracts
  console  --port 7788   operator console for human takeover
  catalog  --port 7789   expose capabilities as agent-callable tools
  agent-demo --ask "<request>" [--out transcript.json]
           show an AI agent choosing and invoking a capability by name
  schema   [--out capability.schema.json]
`);
      return cmd ? 2 : 0;
  }
}

main().then((c) => process.exit(c)).catch((e) => { console.error(C.red(String(e?.stack ?? e))); process.exit(1); });

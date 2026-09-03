/**
 * An AI agent invoking a recorded capability by name.
 *
 * This is the loop the brief opens with, closed: the agent-facing product decides
 * WHAT to do, and this system is how it does it. Claude is given the catalog as
 * tools -- names, typed schemas, and the business outcomes each can return -- and
 * nothing else. It does not know a browser exists.
 *
 * Note what the agent gets back from a "no such member" call: a structured
 * MEMBER_NOT_FOUND, which it can reason about and report. If that had arrived as
 * an exception, the only sensible thing an agent could do is retry or give up.
 */
import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { baseOptions, createSdkMcpServer, MODEL, runQuery, tool } from '../learn/model.js';
import { listCapabilities, runReplay } from '../run.js';
import { loadPolicy } from '../policy/guardrails.js';
import { toolDescriptor } from './server.js';

export async function agentDemo(opts: { ask: string; policyPath?: string; out?: string }): Promise<number> {
  const caps = listCapabilities();
  if (!caps.length) { console.error('no capabilities recorded yet -- run `npm run learn` first'); return 1; }
  const requireStatus = loadPolicy(opts.policyPath ?? 'policy.dev.yaml').requireStatus;

  const calls: { capability: string; args: unknown; status: string; summary: string }[] = [];

  const tools = caps.map((cap) => {
    const d = toolDescriptor(cap);
    // The tool's argument schema is built from the artifact's own input
    // declarations, so an agent physically cannot call it with the wrong shape.
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of cap.inputs) {
      const base = p.enum
        ? z.enum(p.enum as [string, ...string[]])
        : p.pattern ? z.string().regex(new RegExp(p.pattern)) : z.string();
      shape[p.name] = base.describe(`${p.description}${p.example ? ` e.g. "${p.example}"` : ''}`);
    }
    return tool(String(d.name), String(d.description), shape, async (rawArgs) => {
      // Invocation metadata travels alongside the typed args and is consumed
      // here, so it never reaches input validation as an unknown parameter.
      const { invokedBy, idempotencyKey, ...args } = (rawArgs ?? {}) as Record<string, unknown>;
      const { result } = await runReplay(cap, args as Record<string, string>, {
        policyPath: opts.policyPath, label: 'agent',
        invokedBy: typeof invokedBy === 'string' ? invokedBy : 'agent-demo(claude)',
        idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      });
      const summary =
        result.status === 'success' ? `SUCCESS ${JSON.stringify(result.outputs)}`
        : result.status === 'business_outcome' ? `BUSINESS OUTCOME ${result.outcome.code}: ${result.outcome.message}${result.outcome.data ? ` ${JSON.stringify(result.outcome.data)}` : ''}`
        : result.status === 'blocked_by_policy' ? `BLOCKED BY POLICY: ${result.violation.detail}`
        : result.status === 'failed' ? `FAILED (${result.error.class}) at step ${result.error.stepId}: ${result.error.message}`
        : `ESCALATED to a human operator: ${result.intervention.resolution}`;
      calls.push({ capability: `${cap.id}@${cap.version}`, args, status: result.status, summary });
      console.log(`  ↳ ${cap.id} ${JSON.stringify(args)}\n    ${summary}`);
      return { content: [{ type: 'text' as const, text: summary }] };
    });
  });

  const server = createSdkMcpServer({ name: 'capabilities', version: '1.0.0', tools });
  const names = tools.map((_, i) => String(toolDescriptor(caps[i]!).name));

  console.log(`catalog offers ${caps.length} capability(ies) to the agent:`);
  for (const c of caps) console.log(`  ${c.id}@${c.version} (${c.status})  in(${c.inputs.map((i) => i.name).join(', ')}) -> out(${c.outputs.map((o) => o.name).join(', ')})`);
  console.log(`\nasking the agent: "${opts.ask}"\n`);

  const res = await runQuery(opts.ask, baseOptions('capabilities', names, {
    mcpServers: { capabilities: server },
    maxTurns: 8,
    /**
     * Permission is granted here and nowhere else -- the same reason the
     * discovery loop does it this way: a bare name in `allowedTools`
     * auto-approves before the callback runs, which would take the approval
     * gate out of the loop entirely.
     *
     * It is also the natural place for the approval-state gate. An agent may
     * call a capability only if the deployment's policy is satisfied by its
     * status, so a `draft` recording cannot be invoked unattended in production
     * however convincingly the agent argues for it.
     */
    canUseTool: async (toolName, input) => {
      const short = toolName.replace(/^mcp__capabilities__/, '');
      const cap = caps.find((c) => String(toolDescriptor(c).name) === short);
      if (!cap) return { behavior: 'deny', message: `"${toolName}" is not in the capability catalog.` };
      const rank = { draft: 0, verified: 1, approved: 2 };
      if (rank[cap.status] < rank[requireStatus]) {
        return { behavior: 'deny',
          message: `"${cap.id}" is ${cap.status}; this deployment requires ${requireStatus} before a capability may be invoked unattended.` };
      }
      return { behavior: 'allow', updatedInput: input };
    },
    systemPrompt:
      'You are a back-office assistant for a credit union. Use the capabilities you have been given ' +
      'to carry out the request, then report plainly what happened. A "business outcome" is a real ' +
      'answer from the core system, not an error -- report it as the answer, and do not retry it.',
  }));

  console.log(`\nagent said:\n${res.text}\n`);
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ ask: opts.ask, model: MODEL, calls, agentReply: res.text, turns: res.turns, costUsd: res.costUsd }, null, 2));
    console.log(`transcript: ${opts.out}`);
  }
  return calls.length ? 0 : 1;
}

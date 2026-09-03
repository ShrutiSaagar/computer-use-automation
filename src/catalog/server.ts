/**
 * The agent-facing capability catalog.
 *
 * This closes the loop the brief opens with: "the agent-facing product decides
 * what to do; this system is how it reliably does it". A calling agent lists
 * capabilities, reads their JSON Schemas, and invokes one by name with typed
 * arguments -- with no idea that a browser is involved.
 *
 * The schemas are not written by hand. They are generated from the same zod
 * definition that validates the artifact and types the engine, so a capability's
 * contract cannot drift from what it actually accepts.
 */
import express from 'express';
import { z } from 'zod';
import type { Capability } from '../schema/capability.js';
import { listCapabilities, loadCapability, runReplay } from '../run.js';
import { loadPolicy } from '../policy/guardrails.js';

/** JSON Schema for a capability's inputs -- the shape an agent's tool-call takes. */
export function inputSchema(cap: Capability): Record<string, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of cap.inputs) {
    let t: z.ZodTypeAny =
      p.type === 'number' ? z.number()
      : p.type === 'boolean' ? z.boolean()
      : p.enum ? z.enum(p.enum as [string, ...string[]])
      : p.pattern ? z.string().regex(new RegExp(p.pattern))
      : z.string();
    t = t.describe(p.description + (p.example ? ` (e.g. "${p.example}")` : ''));
    shape[p.name] = p.required ? t : t.optional();
  }
  return z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
}

export function outputSchema(cap: Capability): Record<string, unknown> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const o of cap.outputs) {
    shape[o.name] = (o.type === 'number' ? z.number() : o.type === 'boolean' ? z.boolean() : z.string())
      .describe(o.description);
  }
  return z.toJSONSchema(z.object(shape), { io: 'output' }) as Record<string, unknown>;
}

/** The tool descriptor an agent framework consumes. */
export function toolDescriptor(cap: Capability): Record<string, unknown> {
  return {
    name: cap.id.replace(/\./g, '_'),
    capability: `${cap.id}@${cap.version}`,
    status: cap.status,
    description:
      `${cap.description}\n\n` +
      `Returns one of: success (with the declared outputs), or a known business outcome ` +
      `[${(cap.signals.filter((s) => s.classify === 'business_outcome').map((s) => s.outcome!.code)).join(', ') || 'none declared'}], ` +
      `or a failure with a debuggable reason. A business outcome is an ANSWER, not an error.` +
      (cap.requires?.session ? `\nRequires: ${cap.requires.session.describe ?? 'an authenticated session'} -- established automatically when policy allows.` : '') +
      (cap.requires?.data.length ? `\nData preconditions verified before the flow starts: ${cap.requires.data.map((d) => d.name).join(', ')}.` : ''),
    input_schema: inputSchema(cap),
    output_schema: outputSchema(cap),
    outcomes: cap.signals
      .filter((s) => s.classify === 'business_outcome')
      .map((s) => ({ code: s.outcome!.code, meaning: s.outcome!.message })),
    /** The composed skills, so an agent (and a reviewer) sees the delegation. */
    uses: cap.uses.map((u) => ({ name: u.name, capability: u.capabilityId, version: u.version, purpose: u.purpose })),
  };
}

export async function startCatalog(opts: { port: number; policyPath?: string }): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/capabilities', (_req, res) => res.json(listCapabilities().map(toolDescriptor)));

  app.get('/capabilities/:id', (req, res) => {
    try { res.json(toolDescriptor(loadCapability(req.params.id))); }
    catch (e) { res.status(404).json({ error: String((e as Error).message) }); }
  });

  /** The production execution path an AI agent triggers. */
  app.post('/capabilities/:id/invoke', async (req, res) => {
    let cap;
    try { cap = loadCapability(req.params.id); }
    catch (e) { res.status(404).json({ error: String((e as Error).message) }); return; }

    const policy = loadPolicy(opts.policyPath ?? 'policy.dev.yaml');
    const rank = { draft: 0, verified: 1, approved: 2 };
    if (rank[cap.status] < rank[policy.requireStatus]) {
      // Refused before a browser is even launched: an unreviewed capability is
      // not something an unattended agent gets to run.
      res.status(403).json({
        status: 'blocked_by_policy',
        violation: { rule: 'requireStatus', detail: `capability is "${cap.status}", policy "${policy.name}" requires "${policy.requireStatus}"` },
      });
      return;
    }

    // Invocation metadata travels alongside the typed args and is consumed
    // here, so it never reaches input validation as an unknown parameter.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { invokedBy, idempotencyKey, ...inputs } = body;

    const { result } = await runReplay(cap, inputs, {
      policyPath: opts.policyPath, label: 'catalog',
      invokedBy: typeof invokedBy === 'string' ? invokedBy : `catalog:${req.ip ?? 'unknown'}`,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
    });
    // HTTP status reflects the CALLER's contract, not HTTP folklore: a business
    // outcome is a successful invocation that returned a non-happy answer.
    const code =
      result.status === 'success' || result.status === 'business_outcome' ? 200
      : result.status === 'blocked_by_policy' ? 403
      // A broken input contract is the caller's mistake, not ours.
      : result.status === 'failed' && result.error.class === 'invalid_input' ? 400
      // The conditions to run are not met (yet): retryable later, unlike a bug.
      : result.status === 'failed' && result.error.class === 'precondition_not_met' ? 409
      : result.status === 'escalated' ? 202
      : 500;
    res.status(code).json(result);
  });

  await new Promise<void>((resolve) => { app.listen(opts.port, () => resolve()); });
  const caps = listCapabilities();
  console.log(`capability catalog  http://localhost:${opts.port}`);
  console.log(`  GET  /capabilities                     list tool descriptors (JSON Schema)`);
  console.log(`  POST /capabilities/<id>/invoke         run one with typed args`);
  for (const c of caps) console.log(`    - ${c.id}@${c.version} (${c.status})`);
}

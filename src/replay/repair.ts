/**
 * Bounded single-step locator repair.
 *
 * Loaded by dynamic import so that with assistedRecovery off -- the default --
 * the model SDK is never even required into the process. Determinism you can
 * verify by reading the import graph is worth more than determinism you have to
 * take on faith.
 *
 * The contract with the model is deliberately narrow. It sees one step's intent,
 * why the recorded locator failed, and the current screen. It may return one
 * replacement locator. It cannot change the action, the value, the ordering or
 * the risk class, and its answer is not trusted: the returned locator is resolved
 * through the same ladder and guard as any other, and the step's checkpoint still
 * has to pass afterwards. If it is wrong, we escalate to a human exactly as we
 * would have without it.
 */
import { z } from 'zod';
import type { Capability, Locator, Step } from '../schema/capability.js';
import type { Observation } from '../surface/types.js';
import { baseOptions, createSdkMcpServer, MODEL, renderObservation, runQuery, tool } from '../learn/model.js';

export type RepairResult = { locator: Locator; rationale: string; model: string };

export async function repairLocator(args: {
  step: Step;
  obs: Observation;
  why: string;
  capability: Capability;
}): Promise<RepairResult | null> {
  const { step, obs, why, capability } = args;
  let captured: RepairResult | null = null;

  const proposal = tool(
    'propose_locator',
    'Propose a replacement way to find the control this step needs. Call this exactly once.',
    {
      ref: z.string().describe('The [ref=...] of the control on the current screen that this step should act on.'),
      role: z.string().describe('That control\'s role, exactly as shown in the snapshot.'),
      name: z.string().describe('That control\'s accessible name, or "" if it has none.'),
      anchorText: z.string().describe('The nearest caption text a human would read as labelling this control. Required when name is empty.'),
      ordinal: z.number().describe('How many controls of the same role sit between that caption and this control. Usually 0.'),
      rationale: z.string().describe('One sentence: why this is the right control for the stated intent.'),
    },
    async (a) => {
      const strategies: Locator['strategies'] = [];
      if (a.name) strategies.push({ kind: 'role_name', role: a.role, name: a.name, exact: true });
      if (a.anchorText) strategies.push({ kind: 'anchor', anchorText: a.anchorText, role: a.role, ordinal: a.ordinal ?? 0 });
      captured = {
        locator: {
          description: `${step.target?.description ?? step.intent} (repaired)`,
          frame: step.target?.frame,
          strategies: strategies.length ? strategies : [{ kind: 'role_name', role: a.role, name: a.name, exact: true }],
          recordedRank: 0,
          guard: { role: a.role, name: a.name || undefined },
        },
        rationale: a.rationale,
        model: MODEL,
      };
      return { content: [{ type: 'text' as const, text: 'Proposal recorded.' }] };
    },
  );

  const server = createSdkMcpServer({ name: 'repair', version: '1.0.0', tools: [proposal] });

  const prompt = `A recorded automation step for the capability "${capability.id}" can no longer find its control.

STEP INTENT: ${step.intent}
ACTION: ${step.action}
RECORDED TARGET: ${step.target?.description ?? '(none)'}
WHY IT FAILED: ${why}

This is the screen right now:

${renderObservation(obs)}

Find the control that this step's intent describes and call propose_locator once.
Prefer a caption-anchored answer: on this application most fields have no accessible
name, and the only durable thing about them is the caption text next to them.
If no control on this screen plausibly matches the intent, do not call the tool at all.`;

  await runQuery(
    prompt,
    baseOptions('repair', ['propose_locator'], {
      mcpServers: { repair: server },
      maxTurns: 3,
      systemPrompt: 'You repair a single broken UI locator. You never invent controls that are not in the snapshot you were given.',
    }),
  );

  return captured;
}

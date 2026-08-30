/**
 * The learning engine: an LLM driving a live surface, and the trace that becomes
 * a capability.
 *
 * Two things are worth noticing about the design.
 *
 * First, the model never writes the artifact. It acts, and it declares a
 * contract; the artifact is COMPILED from what actually happened (see
 * compile.ts). Asking a model to emit a locator ladder would mean trusting it to
 * remember an element's id, its frame, its bounding box and the caption beside
 * it. We were standing right there when the click happened -- we should record
 * it, not ask.
 *
 * Second, the model never sees the credentials. It types the literal placeholders
 * {{OPERATOR_USERNAME}} / {{OPERATOR_PASSWORD}}; the tool substitutes real values
 * at the last moment and records the placeholder in the trace, which is also
 * exactly what the compiled artifact stores. The secret is never in the context
 * window, never in the transcript, and never in the artifact.
 */
import { z } from 'zod';
import type { Observation, RecordedElement } from '../surface/types.js';
import type { WebSurface } from '../surface/web.js';
import type { Policy } from '../policy/guardrails.js';
import { assertAllowed } from '../policy/guardrails.js';
import type { Redactor } from '../policy/redact.js';
import type { Evidence } from '../evidence/logger.js';
import { baseOptions, createSdkMcpServer, MODEL, renderObservation, runQuery, tool } from './model.js';

export const USERNAME_PLACEHOLDER = '{{OPERATOR_USERNAME}}';
export const PASSWORD_PLACEHOLDER = '{{OPERATOR_PASSWORD}}';

export type TraceEntry = {
  seq: number;
  tool: 'navigate' | 'click' | 'type' | 'select';
  /** What the model said it was doing. Becomes the step's intent. */
  why: string;
  /** As recorded: a placeholder for a secret, the literal otherwise. */
  value?: string;
  url?: string;
  element?: RecordedElement;
  frameName?: string;
  urlBefore: string;
  urlAfter: string;
  /** Visible text of the screen this action produced. Kept so the compiler can
   *  test every declared outcome detector against screens the happy path
   *  actually visited. */
  textAfter: string;
  frameUrlsBefore: Record<string, string>;
  frameUrlsAfter: Record<string, string>;
  /** Named nodes that appeared as a result. The compiler derives checkpoints
   *  from this rather than guessing what "success" looked like. */
  appeared: { role: string; name: string }[];
  ok: boolean;
  error?: string;
};

export type Extraction = { name: string; element: RecordedElement; value: string; description: string };

export const FinalizeShape = {
  id: z.string().describe('Dotted capability id, e.g. "member.subaccount.open".'),
  name: z.string().describe('Short human title.'),
  description: z.string().describe('What this capability does, what it needs, and what it returns. Written for another AI agent deciding whether to call it.'),
  inputs: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string(),
    pattern: z.string().optional().describe('Regex the value must match, e.g. "^\\\\d{6}$" for a six-digit id. Supply this whenever the value has any evident shape -- it is how a calling agent is stopped from passing nonsense before the browser is even opened.'),
    enumValues: z.array(z.string()).optional().describe('If the field is a dropdown, list the options you saw.'),
    sensitivity: z.enum(['none', 'identifier', 'account_number', 'amount', 'pii', 'secret']),
    example: z.string().describe('The exact value you used during this run. This is how the recorded steps get parameterised, so it must match character for character.'),
  })).describe('The typed arguments a calling agent supplies.'),
  steps: z.array(z.object({
    seq: z.number().describe('The seq number of ONE recorded action, exactly as reported to you as "Done (seq=N)".'),
    intent: z.string().describe('One sentence describing THIS SINGLE action. Not a summary of several.'),
    risk: z.enum(['safe', 'risky', 'irreversible']).describe('safe = reads or fills; risky = mutates but is reversible; irreversible = posts, transfers, deletes.'),
  })).describe('ONE ENTRY PER RECORDED ACTION that belongs in the replayable flow, in order. Do not merge several actions into one entry -- every typed field and every click needs its own entry, or replay will skip it. Call review_recording() first to get the exact list.'),
  droppedSeqs: z.array(z.number()).describe('Every other recorded seq -- dead ends, exploration, corrections. steps[] plus droppedSeqs MUST together account for every successful action; this is checked.'),
  outputs: z.array(z.object({
    name: z.string().describe('Must match a name you passed to extract().'),
    type: z.enum(['string', 'number', 'boolean']),
    description: z.string(),
    pattern: z.string().optional().describe('Regex the extracted value must match. SUPPLY THIS whenever the value has a shape you can see -- "0003-100482" is "^\\\\d{4}-\\\\d{6}$", a date is "^\\\\d{4}-\\\\d{2}-\\\\d{2}$". It is asserted on every replay, and it is the only thing standing between a caller and a confidently wrong answer scraped from the wrong cell.'),
    sensitivity: z.enum(['none', 'identifier', 'account_number', 'amount', 'pii', 'secret']),
  })),
  checkpointText: z.string().describe('Text that appears on screen if and only if the goal was reached.'),
  businessOutcomes: z.array(z.object({
    code: z.string().describe('SCREAMING_SNAKE code, e.g. MEMBER_NOT_FOUND.'),
    message: z.string(),
    whenTextMatches: z.string().describe('Regex matching the ERROR OR RESULT MESSAGE the app shows for this outcome -- never a field label, hint, or piece of permanent page furniture. "min $25.00" sits next to the deposit box on every render and would fire immediately; "Opening deposit must be at least" only appears when the app has actually rejected something. Detectors are tested against the screens this run visited, and one that matches a normal screen is rejected.'),
    description: z.string(),
  })).describe('Legitimate non-happy-path answers this app can give -- NOT crashes. Include any you saw, plus any you are confident about from error text you encountered.'),
};

export type FinalizeArgs = {
  id: string; name: string; description: string;
  inputs: { name: string; type: 'string'|'number'|'boolean'; description: string; pattern?: string; enumValues?: string[]; sensitivity: string; example: string }[];
  steps: { seq: number; intent: string; risk: 'safe'|'risky'|'irreversible' }[];
  droppedSeqs: number[];
  outputs: { name: string; type: 'string'|'number'|'boolean'; description: string; pattern?: string; sensitivity: string }[];
  checkpointText: string;
  businessOutcomes: { code: string; message: string; whenTextMatches: string; description: string }[];
};

export type DiscoveryOutcome = {
  environment?: import('../surface/types.js').EnvironmentReport;
  trace: TraceEntry[];
  extractions: Extraction[];
  finalize: FinalizeArgs | null;
  turns: number;
  costUsd?: number;
  error?: string;
  blocked: { tool: string; detail: string }[];
};

export async function discover(args: {
  goal: string;
  target: string;
  surface: WebSurface;
  policy: Policy;
  redactor: Redactor;
  evidence: Evidence;
  credentials?: { username: string; password: string };
  maxSteps: number;
}): Promise<DiscoveryOutcome> {
  const { goal, target, surface, policy, redactor, evidence, credentials, maxSteps } = args;

  const trace: TraceEntry[] = [];
  const extractions: Extraction[] = [];
  const blocked: { tool: string; detail: string }[] = [];
  let finalize: FinalizeArgs | null = null;
  let seq = 0;
  let lastObs: Observation | null = null;

  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

  const observeAndRender = async (label: string): Promise<string> => {
    const obs = await surface.observe();
    lastObs = obs;
    evidence.snapshot(label, { url: obs.url, frameUrls: obs.frameUrls, nodes: obs.nodes });
    evidence.screenshot(label, await surface.screenshot());
    return renderObservation(obs);
  };

  const substitute = (v: string): string =>
    v.replace(USERNAME_PLACEHOLDER, credentials?.username ?? '')
     .replace(PASSWORD_PLACEHOLDER, credentials?.password ?? '');

  /** Record one action: what it was, and what changed because of it. */
  const record = async (
    kind: TraceEntry['tool'], why: string, ref: string | undefined,
    body: () => Promise<void>, extra: Partial<TraceEntry> = {},
  ): Promise<string> => {
    if (trace.length >= maxSteps) {
      return `Step budget of ${maxSteps} reached. Stop acting and call finalize_capability now with what you have.`;
    }
    const before = lastObs ?? (await surface.observe());
    const element = ref ? await surface.describe(ref).catch(() => undefined) : undefined;
    const entry: TraceEntry = {
      seq: seq++, tool: kind, why, element,
      frameName: element ? before.frameNames[element.frame] : undefined,
      urlBefore: before.url, urlAfter: before.url, textAfter: before.text,
      frameUrlsBefore: before.frameUrls, frameUrlsAfter: before.frameUrls,
      appeared: [], ok: true, ...extra,
    };
    try {
      await body();
    } catch (e) {
      entry.ok = false;
      entry.error = String((e as Error).message).slice(0, 300);
      trace.push(entry);
      evidence.event('discovery_action_failed', { seq: entry.seq, tool: kind, error: entry.error });
      return `That failed: ${entry.error}\n\nCurrent screen:\n${await observeAndRender(`s${entry.seq}-failed`)}`;
    }
    // Let the app settle before looking. Discovery can afford a fixed pause;
    // replay cannot, which is why replay polls conditions instead.
    await new Promise((r) => setTimeout(r, 400));
    const after = await surface.observe();
    lastObs = after;
    entry.urlAfter = after.url;
    entry.textAfter = after.text;
    entry.frameUrlsAfter = after.frameUrls;
    entry.appeared = after.nodes
      .filter((n) => n.name && !before.nodes.some((b) => b.role === n.role && b.name === n.name))
      .map((n) => ({ role: n.role, name: n.name }));
    trace.push(entry);
    evidence.event('discovery_action', {
      seq: entry.seq, tool: kind, why, control: element?.name || element?.anchorText,
      urlAfter: entry.urlAfter, appeared: entry.appeared.length,
    });
    evidence.snapshot(`s${entry.seq}-after`, { url: after.url, frameUrls: after.frameUrls, nodes: after.nodes });
    evidence.screenshot(`s${entry.seq}-after`, await surface.screenshot());
    return `Done (seq=${entry.seq}). Screen now:\n\n${renderObservation(after)}`;
  };

  const tools = [
    tool('observe', 'Look at the current screen. Returns the accessibility tree with [ref=...] handles you act on.',
      {}, async () => text(await observeAndRender(`observe-${seq}`))),

    tool('navigate', 'Go to a URL.', { url: z.string(), why: z.string() },
      async (a) => text(await record('navigate', a.why, undefined, () => surface.act({ kind: 'navigate', url: a.url }), { url: a.url }))),

    tool('click', 'Click a control by its ref.', { ref: z.string(), why: z.string().describe('One sentence: why this click, in terms of the goal.') },
      async (a) => text(await record('click', a.why, a.ref, () => surface.act({ kind: 'click', ref: a.ref })))),

    tool('type', `Type into a field by its ref. For credentials use the literal placeholders ${USERNAME_PLACEHOLDER} and ${PASSWORD_PLACEHOLDER} -- the harness substitutes the real values, which you are never shown.`,
      { ref: z.string(), value: z.string(), why: z.string() },
      async (a) => text(await record('type', a.why, a.ref,
        () => surface.act({ kind: 'type', ref: a.ref, value: substitute(a.value) }), { value: a.value }))),

    tool('select', 'Choose an option in a dropdown by its ref.', { ref: z.string(), value: z.string(), why: z.string() },
      async (a) => text(await record('select', a.why, a.ref,
        () => surface.act({ kind: 'select', ref: a.ref, value: a.value }), { value: a.value }))),

    tool('extract',
      'Record a value on the current screen as one of this capability\'s outputs. Call this on the final screen for every value the caller should get back.',
      { ref: z.string(), name: z.string().describe('camelCase output name, e.g. newAccountNumber'), description: z.string() },
      async (a) => {
        const el = await surface.describe(a.ref);
        const value = (await surface.read(a.ref, 'text')) ?? '';
        extractions.push({ name: a.name, element: el, value, description: a.description });
        evidence.event('discovery_extract', { name: a.name, value: redactor.redact(value) });
        return text(`Recorded output "${a.name}" = ${value}`);
      }),

    tool('review_recording',
      'List every action recorded so far with its seq number. Call this before finalize_capability so the step list you declare matches what was actually recorded.',
      {},
      async () => text(
        trace.length
          ? trace.map((t) => `seq=${t.seq} ${t.ok ? 'ok  ' : 'FAIL'} ${t.tool}` +
              `${t.element ? ` on ${t.element.name ? `"${t.element.name}"` : `the ${t.element.role} next to "${t.element.anchorText}"`}` : ''}` +
              `${t.value !== undefined ? ` value=${JSON.stringify(t.value)}` : ''}` +
              `${t.url ? ` url=${t.url}` : ''}  -- ${t.why}`).join('\n')
          : 'nothing recorded yet',
      )),

    tool('finalize_capability',
      'Declare the reusable contract for what you just did, and stop. Call this exactly once, when the goal is reached.',
      FinalizeShape,
      async (a) => {
        finalize = a as unknown as FinalizeArgs;
        evidence.event('discovery_finalize', { id: a.id, steps: a.steps.length, inputs: a.inputs.length, outputs: a.outputs.length });
        return text('Contract recorded. You are done -- stop now.');
      }),
  ];

  const server = createSdkMcpServer({ name: 'cua', version: '1.0.0', tools });
  const toolNames = ['observe', 'navigate', 'click', 'type', 'select', 'extract', 'review_recording', 'finalize_capability'];

  const system = `You operate a legacy bank back-office application through an accessibility tree, the way a screen-reader user would.

HOW TO WORK
- observe() first. Act on controls by their [ref=...]. Refs change after every action, so re-read the screen from each tool result rather than reusing an old ref.
- This is a frameset application. Controls in different frames are shown with different ref prefixes; that is normal.
- Many fields have NO accessible name -- they show as \`textbox [ref=...]\` with an empty name. Identify those by the caption text in the cell beside them.
- Every action you take is being recorded so it can be replayed later without you. Give a real one-sentence reason for each one; those sentences become the documentation.
- If something fails, read the screen before retrying. Do not repeat a failing action unchanged.
- This run is unattended. There is nobody to ask, so never wait for input: work from what is on the screen.
- Knowing how this application reports problems is part of the contract you are producing. If there is a cheap, READ-ONLY way to see one -- searching for a record that plainly does not exist, for instance -- do it once before the real flow and note the exact wording. Never probe by mutating anything.

WHEN YOU REACH THE GOAL
1. extract() every value the caller should get back.
2. review_recording() to see the exact seq numbers of everything you did.
3. finalize_capability() once. Two things people get wrong here:
   - steps[] takes ONE ENTRY PER RECORDED ACTION, not one entry per phase. If you
     typed into three fields, that is three entries. Merging them means replay
     silently skips fields.
   - steps[] plus droppedSeqs must together cover every successful seq. This is
     checked, and compilation fails if an action is unaccounted for.
   Give each input the EXACT value you used as its example, character for
   character -- that is how the recording gets parameterised.
   Give a pattern for every input and output whose value has a visible shape.
   Those regexes are enforced on every future call; without them a caller can
   pass rubbish and a mis-scraped cell can be returned as a real answer.
   Name the capability for what it DOES, not for the particular values you used:
   if the account type is an input, it does not belong in the id.
4. Then stop.

RISK CLASSIFICATION matters and is yours to judge:
  safe          reads, searches, filling in a form
  risky         mutates something reversible, e.g. creating a pending request
  irreversible  posts to the core, moves money, deletes -- the point of no return`;

  const prompt = `GOAL: ${goal}

The application is at ${target}. Start by navigating there.`;

  evidence.event('discovery_start', { goal, target, model: MODEL, maxSteps });

  const res = await runQuery(
    prompt,
    baseOptions('cua', toolNames, {
      mcpServers: { cua: server },
      systemPrompt: system,
      maxTurns: Math.max(30, maxSteps * 2),
      /**
       * The guardrail seam for discovery.
       *
       * A denial comes back to the model as a tool error, so it re-plans instead
       * of the run dying -- which is what you want from a guardrail during
       * exploration. Crucially this is the SAME assertAllowed() the replay engine
       * calls: a rule the discovery agent could walk around would not be a rule.
       */
      canUseTool: async (toolName, input) => {
        const kind = toolName.replace(/^mcp__cua__/, '');
        // Permission is granted only through this callback, so it is also where
        // the tool surface itself is enforced.
        if (!toolNames.includes(kind)) {
          blocked.push({ tool: toolName, detail: 'tool is not part of the computer-use surface' });
          evidence.event('discovery_blocked', { tool: toolName, rule: 'toolSurface', detail: 'not a computer-use tool' });
          // The message matters: a bare refusal reads as terminal, and the agent
          // abandons the run. Tell it what to do instead.
          return { behavior: 'deny', message:
            `"${toolName}" is not available in this environment. There is nobody to ask and nothing to read ` +
            `outside the application. Continue using observe / navigate / click / type / select / extract, ` +
            `and if the goal genuinely cannot be reached, say why instead of stopping.` };
        }
        if (kind === 'navigate') {
          const d = assertAllowed({ kind: 'navigate', url: String(input.url ?? '') }, { policy });
          if (d.effect !== 'allow') {
            blocked.push({ tool: kind, detail: d.detail });
            evidence.event('discovery_blocked', { tool: kind, rule: d.rule, detail: d.detail });
            return { behavior: 'deny', message: `Blocked by policy (${d.rule}): ${d.detail}. Stay within the allowed application.` };
          }
        }
        if (kind === 'click' && lastObs) {
          const name = lastObs.nodes.find((n) => n.ref === input.ref)?.name;
          const d = assertAllowed({ kind: 'click', ref: String(input.ref) }, { policy, controlName: name });
          if (d.effect === 'block') {
            blocked.push({ tool: kind, detail: d.detail });
            evidence.event('discovery_blocked', { tool: kind, rule: d.rule, detail: d.detail });
            return { behavior: 'deny', message: `Blocked by policy (${d.rule}): ${d.detail}. Do not attempt this control.` };
          }
        }
        return { behavior: 'allow', updatedInput: input };
      },
    }),
    (m) => {
      const msg = m as { type?: string; message?: { content?: { type: string; text?: string }[] } };
      if (msg.type === 'assistant') {
        for (const c of msg.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) evidence.event('model_reasoning', { text: c.text.slice(0, 1500) });
        }
      }
    },
  );

  // Record the conditions this flow was learned under, so a replay can reproduce
  // them rather than hope they match.
  const environment = await surface.environment().catch(() => undefined);
  evidence.event('discovery_end', { turns: res.turns, costUsd: res.costUsd, actions: trace.length, error: res.error, environment });
  return { environment, trace, extractions, finalize, turns: res.turns, costUsd: res.costUsd, error: res.error, blocked };
}

/**
 * The one place that talks to a model.
 *
 * We drive Claude through the Claude Agent SDK rather than the raw Messages API.
 * The trade-off, stated plainly because it is the kind of thing worth defending:
 * we do not own the message loop. What we DO own is everything that matters for
 * this system -- the tool surface the model can act through, the perception
 * format it reasons over, and the permission callback that every tool call has to
 * pass. The SDK supplies transport, turn-taking and retries; the agent's actual
 * policy is ours.
 *
 * Practical upside: it authenticates with whatever the host already has. A Claude
 * Code subscription works with no key; ANTHROPIC_API_KEY works if set. Same code
 * path, so a reviewer can run this without being issued anything.
 */
import { createSdkMcpServer, query, tool, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AxNode, Observation } from '../surface/types.js';

export const MODEL = process.env.CUA_MODEL ?? 'claude-sonnet-5';

/**
 * Render an observation for the model.
 *
 * Roles, accessible names and refs -- the same three facts the locator ladder is
 * built from, so what the model reasons about and what we record are the same
 * view of the world. Layout-only nodes are dropped: a legacy page is 90% nested
 * table scaffolding, and feeding that through burns context to say nothing.
 */
export function renderObservation(obs: Observation, opts: { max?: number } = {}): string {
  const keep = (n: AxNode): boolean => {
    if (['generic', 'rowgroup', 'table', 'row', 'paragraph', 'LineBreak'].includes(n.role)) return !!n.text;
    if (n.role === 'cell') return !!(n.name || n.text);
    return true;
  };
  const lines = obs.nodes.filter(keep).slice(0, opts.max ?? 220).map((n) => {
    const name = n.name ? ` "${n.name}"` : '';
    const text = n.text && n.text !== n.name ? `: ${n.text.slice(0, 120)}` : '';
    const state = ['disabled', 'checked', 'expanded'].filter((k) => n.props[k]).map((k) => `[${k}]`).join('');
    return `${'  '.repeat(Math.min(n.depth, 6))}${n.role}${name} [ref=${n.ref}]${state}${text}`;
  });
  const frames = Object.entries(obs.frameUrls)
    .map(([id, url]) => `${id}${obs.frameNames[id] ? `(${obs.frameNames[id]})` : ''}=${url}`)
    .join('  ');
  return `URL: ${obs.url}\nFRAMES: ${frames}\n\n${lines.join('\n')}`;
}

export type ToolDef = ReturnType<typeof tool>;

export { createSdkMcpServer, query, tool };
export type { Options, PermissionResult };

/**
 * Run a query to completion, returning the final text and cost.
 *
 * Structured data comes back through TOOL CALLS whose handlers capture their
 * arguments, not by parsing prose out of `result`. A tool call is schema-checked
 * by the API; a parsed paragraph is a guess.
 */
export async function runQuery(
  prompt: string,
  options: Options,
  onMessage?: (m: unknown) => void,
): Promise<{ text: string; turns: number; costUsd?: number; error?: string }> {
  let text = '';
  let turns = 0;
  let costUsd: number | undefined;
  let error: string | undefined;

  for await (const message of query({ prompt, options })) {
    onMessage?.(message);
    const m = message as { type: string; subtype?: string; result?: string; num_turns?: number; total_cost_usd?: number };
    if (m.type === 'result') {
      turns = m.num_turns ?? 0;
      costUsd = m.total_cost_usd;
      if (m.subtype === 'success') text = m.result ?? '';
      else error = `${m.subtype}: ${m.result ?? ''}`;
    }
  }
  return { text, turns, costUsd, error };
}

/** Options shared by both model-driven paths. Hermetic by construction:
 *  no user settings, no CLAUDE.md, no built-in tools -- only what we hand it. */
export function baseOptions(mcpName: string, toolNames: string[], extra: Partial<Options> = {}): Options {
  return {
    model: MODEL,
    // Do not inherit the host's settings or project memory. A discovery run has
    // to be reproducible from this repository alone.
    settingSources: [],
    // Deliberately NOT allowedTools. A bare tool name in allowedTools
    // auto-approves the call BEFORE canUseTool is consulted -- the SDK warns
    // about this explicitly -- which silently disables the guardrail callback.
    // A guardrail that does not run is not a guardrail, so permission is granted
    // only through canUseTool.
    //
    // toolNames is still taken so the caller documents its surface in one place.
    // Anything not in it is refused by the callback.
    // Belt and braces: the model gets our tools and nothing that could touch the
    // filesystem or the network on its own.
    // AskUserQuestion is in this list for a specific reason: a discovery run is
    // unattended, so an agent that stops to ask a question stops for good. It has
    // to work with what it can see, or fail and say why.
    disallowedTools: [
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      'Task', 'NotebookEdit', 'AskUserQuestion', 'TodoWrite', 'ExitPlanMode',
    ],
    ...extra,
  };
}

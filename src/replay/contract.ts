/**
 * The input half of the capability contract: what a caller must bring.
 *
 * Broken out of engine.ts so the preflight gate can check contracts without
 * importing the engine (the check must never depend on the executor).
 */
import type { Capability, ValueExpr } from '../schema/capability.js';

export type InputCheck = { ok: true; values: Record<string, string> } | { ok: false; message: string };

export function validateInputs(cap: Capability, given: Record<string, unknown>): InputCheck {
  const values: Record<string, string> = {};
  for (const p of cap.inputs) {
    const raw = given[p.name] ?? p.default;
    if (raw === undefined || raw === '') {
      if (p.required) return { ok: false, message: `missing required input "${p.name}" (${p.description})` };
      continue;
    }
    const v = String(raw);
    if (p.type === 'number' && !Number.isFinite(Number(v))) {
      return { ok: false, message: `input "${p.name}" must be a number, got "${v}"` };
    }
    if (p.pattern && !new RegExp(p.pattern).test(v)) {
      return { ok: false, message: `input "${p.name}" must match /${p.pattern}/, got "${v}"` };
    }
    if (p.enum && !p.enum.includes(v)) {
      return { ok: false, message: `input "${p.name}" must be one of [${p.enum.join(', ')}], got "${v}"` };
    }
    values[p.name] = v;
  }
  const unknown = Object.keys(given).filter((k) => !cap.inputs.some((p) => p.name === k));
  if (unknown.length) return { ok: false, message: `unknown input(s): ${unknown.join(', ')}` };
  return { ok: true, values };
}

/** Resolve a literal / $param / $secret expression against the run's values. */
export function resolveValueExpr(
  expr: ValueExpr | undefined,
  values: Record<string, string>,
  resolveSecret: (ref: string) => string,
): string {
  if (expr === undefined) return '';
  if (typeof expr === 'string') return expr;
  if ('$param' in expr) {
    const v = values[expr.$param];
    if (v === undefined) throw new Error(`step references unknown parameter "${expr.$param}"`);
    return v;
  }
  return resolveSecret(expr.$secret);
}

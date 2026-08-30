/**
 * Redaction, applied at exactly one boundary: everything on its way to disk.
 *
 * The temptation is to sprinkle redaction at call sites. That fails the first
 * time someone adds a log line, and you cannot tell by reading the code whether
 * a given path is covered. One chokepoint you can audit in a single sitting is
 * worth more than careful discipline everywhere.
 *
 * Three sources of things that must not be persisted:
 *   1. registered secrets  -- resolved credential values, registered at startup
 *   2. sensitive inputs    -- invocation arguments whose param declares sensitivity
 *   3. shape patterns      -- SSNs and card numbers, wherever they turn up
 */

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '⟪redacted:ssn⟫'],
  // Anchored so a long run of digits that is part of a NUMBER is not mistaken
  // for a card. Without the lookarounds this matched the fractional digits of a
  // float (0.24173490000000003) and rewrote it mid-number.
  [/(?<![\d.])(?:\d[ -]?){13,19}(?![\d.])/g, '⟪redacted:pan⟫'],
  [/\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi, '$&'],
];

export class Redactor {
  private secrets: string[] = [];
  private labelled: [string, string][] = [];

  /** Register a value that must never appear on disk, whatever it is. */
  addSecret(value: string | undefined): void {
    if (value && value.length >= 4) this.secrets.push(value);
  }

  /** Register an invocation argument, tagged with the param it came from, so the
   *  evidence shows WHICH input was there without showing what it was. */
  addSensitive(paramName: string, value: string | undefined, sensitivity: string): void {
    if (!value || sensitivity === 'none' || value.length < 2) return;
    this.labelled.push([value, `⟪${sensitivity}:${paramName}⟫`]);
  }

  redact(input: string): string {
    let out = input;
    // Longest first, so a short secret that is a substring of a longer one does
    // not carve the longer one up and leave fragments behind.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join('⟪redacted:credential⟫');
    }
    for (const [v, label] of [...this.labelled].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(v).join(label);
    }
    for (const [re, sub] of PATTERNS) {
      if (sub === '$&') {
        out = out.replace(re, (m) => m.replace(/[=:]\s*\S+$/, (kv) => kv[0] + ' ⟪redacted:secret⟫'));
      } else {
        out = out.replace(re, sub);
      }
    }
    return out;
  }

  /** Deep-redact a structure on its way to JSON. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(v);
      return out as T;
    }
    return value;
  }
}

/**
 * Resolve a credentialRef like "env:CU_CORE_OPERATOR" into { username, password }
 * and register both with the redactor in the same breath -- so it is not possible
 * to obtain a secret without also arranging for it to be scrubbed.
 */
export function resolveCredential(
  ref: string,
  redactor: Redactor,
): { username: string; password: string } {
  const m = /^env:(.+)$/.exec(ref);
  if (!m) throw new Error(`unsupported credentialRef "${ref}" (expected env:NAME)`);
  const prefix = m[1]!;
  const username = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];
  if (!username || !password) {
    throw new Error(
      `credentialRef "${ref}" needs ${prefix}_USERNAME and ${prefix}_PASSWORD in the environment (see .env.example)`,
    );
  }
  redactor.addSecret(password);
  return { username, password };
}

/** Resolve { $secret: "env:CU_CORE_OPERATOR.password" } to its value. */
export function resolveSecretExpr(expr: string, redactor: Redactor): string {
  const m = /^env:(.+)\.(username|password)$/.exec(expr);
  if (!m) throw new Error(`unsupported secret expression "${expr}"`);
  const cred = resolveCredential(`env:${m[1]}`, redactor);
  return m[2] === 'username' ? cred.username : cred.password;
}

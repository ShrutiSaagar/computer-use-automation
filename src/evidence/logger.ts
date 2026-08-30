/**
 * Evidence.
 *
 * Every run -- discovery or replay -- writes one directory containing a
 * structured event log, the accessibility snapshot and a screenshot at each
 * interesting moment, and the final result. Enough to answer "what did it do,
 * and why did it think that was right" without a debugger.
 *
 * Everything written here passes through the Redactor first. That is the single
 * chokepoint: if a value reaches disk unredacted, the bug is in this file, not
 * scattered across thirty call sites.
 */
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Redactor } from '../policy/redact.js';

export type EvidenceKind = 'discovery' | 'replay';

export class Evidence {
  readonly dir: string;
  readonly runId: string;
  private seq = 0;

  constructor(
    kind: EvidenceKind,
    label: string,
    private redactor: Redactor,
    // CUA_EVIDENCE_DIR keeps test runs from littering the curated evidence/
    // directory that ships with the repo.
    root = process.env.CUA_EVIDENCE_DIR ?? 'evidence',
  ) {
    // Stable names make the committed evidence directory browsable and
    // diffable on GitHub; timestamped names are right for day-to-day runs that
    // must not clobber each other.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.runId = process.env.CUA_EVIDENCE_STABLE ? `${kind}-${label}` : `${kind}-${label}-${stamp}`;
    this.dir = join(root, this.runId);
    if (process.env.CUA_EVIDENCE_STABLE) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, 'screenshots'), { recursive: true });
    mkdirSync(join(this.dir, 'snapshots'), { recursive: true });
  }

  /** One JSON object per line. Grep-able, diff-able, and streamable while a run
   *  is still going -- which matters when the thing you are debugging is a hang. */
  event(type: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify(
      this.redactor.redactValue({ ts: new Date().toISOString(), seq: this.seq++, type, ...data }),
    );
    appendFileSync(join(this.dir, 'run.jsonl'), line + '\n');
  }

  screenshot(label: string, png: Buffer): string {
    const name = `${String(this.seq).padStart(3, '0')}-${label}.png`;
    writeFileSync(join(this.dir, 'screenshots', name), png);
    return `screenshots/${name}`;
  }

  snapshot(label: string, content: unknown): string {
    const name = `${String(this.seq).padStart(3, '0')}-${label}.json`;
    writeFileSync(
      join(this.dir, 'snapshots', name),
      JSON.stringify(this.redactor.redactValue(content), null, 1),
    );
    return `snapshots/${name}`;
  }

  /**
   * Redact the value, then serialise. Redacting serialised JSON as text can
   * corrupt it -- a replacement landing inside a number produces `0.⟪redacted⟫`,
   * which is no longer parseable. Structure first, text second.
   */
  json(name: string, value: unknown): string {
    writeFileSync(join(this.dir, name), JSON.stringify(this.redactor.redactValue(value), null, 2));
    return name;
  }

  file(name: string, content: string | Buffer): string {
    const body = typeof content === 'string' ? this.redactor.redact(content) : content;
    writeFileSync(join(this.dir, name), body);
    return name;
  }

  /** Written verbatim -- for the artifact itself, which is already free of
   *  secrets by construction and must stay byte-identical to what replay loads. */
  fileRaw(name: string, content: string): string {
    writeFileSync(join(this.dir, name), content);
    return name;
  }
}

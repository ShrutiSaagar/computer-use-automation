/**
 * The control-transfer model.
 *
 * One live session, one lease, one authoritative answer to "who is driving right
 * now". Everything else about the handoff falls out of that:
 *
 *   - Automation takes the lease for every action. If a human holds it, the
 *     engine is not "paused" by convention, it is structurally unable to act.
 *   - escalate() flips the lease to the human and returns a promise. The engine
 *     is suspended mid-step, on the same BrowserContext, with the same cookies,
 *     the same session, and the same page. Not a fresh session that has to be
 *     driven back to where we were -- that reconstruction is exactly where
 *     handoffs lose state and where a bank loses an audit trail.
 *   - resume() hands the lease back with a decision the engine acts on.
 *
 * What the human did is recorded here rather than reconstructed afterwards,
 * because the operator console forwards their input through this process. We own
 * the pipe, so the audit record is a capture rather than an inference.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Controller, HumanAction, Intervention, InterventionReason, Resolution } from '../schema/intervention.js';

export type EscalationRequest = {
  runId: string;
  capabilityId: string;
  capabilityVersion: number;
  stepId?: string;
  stepIntent?: string;
  reason: InterventionReason;
  summary: string;
  expected?: string;
  observed?: string;
  url: string;
  screenshot?: string;
  snapshot?: string;
  aboutToSubmit?: Record<string, string>;
  allowedResolutions?: Resolution[];
};

export type Resumption = { resolution: Resolution; note?: string; operator?: string };

export class SessionBroker extends EventEmitter {
  private _controller: Controller = 'automation';
  private _pending: Intervention | null = null;
  private _resolve: ((r: Resumption) => void) | null = null;
  private _humanActions: HumanAction[] = [];

  get controller(): Controller { return this._controller; }
  get pending(): Intervention | null { return this._pending; }
  get humanActions(): HumanAction[] { return [...this._humanActions]; }

  /**
   * Every automation action goes through here. When the lease is held by a
   * human, this blocks rather than racing them -- two actors on one session is
   * how you get a click landing on a screen that moved.
   */
  async withControl<T>(fn: () => Promise<T>): Promise<T> {
    while (this._controller !== 'automation') {
      await new Promise<void>((r) => this.once('resumed', () => r()));
    }
    return fn();
  }

  async escalate(req: EscalationRequest): Promise<Resumption> {
    const intervention: Intervention = {
      id: randomUUID().slice(0, 8),
      runId: req.runId,
      capabilityId: req.capabilityId,
      capabilityVersion: req.capabilityVersion,
      stepId: req.stepId,
      stepIntent: req.stepIntent,
      reason: req.reason,
      context: {
        summary: req.summary,
        expected: req.expected,
        observed: req.observed,
        url: req.url,
        screenshot: req.screenshot,
        snapshot: req.snapshot,
        aboutToSubmit: req.aboutToSubmit,
      },
      allowedResolutions:
        req.allowedResolutions ??
        (req.reason === 'confirm_risky'
          ? ['approve', 'reject']
          : ['resume', 'retry_step', 'skip_step', 'abort']),
      createdAt: new Date().toISOString(),
    };

    this._pending = intervention;
    this._humanActions = [];
    this._controller = 'human';
    this.emit('intervention', intervention);

    const resumption = await new Promise<Resumption>((resolve) => { this._resolve = resolve; });

    intervention.resolvedAt = new Date().toISOString();
    intervention.resolution = resumption.resolution;
    intervention.operator = resumption.operator;
    intervention.note = resumption.note;
    this._controller = 'automation';
    this._pending = null;
    this._resolve = null;
    this.emit('resumed', { intervention, resumption });
    return resumption;
  }

  /** Called by the operator console when the human hands control back. */
  resume(id: string, r: Resumption): boolean {
    if (!this._pending || this._pending.id !== id || !this._resolve) return false;
    this._resolve(r);
    return true;
  }

  recordHumanAction(a: Omit<HumanAction, 'ts'>): void {
    const action: HumanAction = { ...a, ts: new Date().toISOString() };
    this._humanActions.push(action);
    this.emit('human_action', action);
  }
}

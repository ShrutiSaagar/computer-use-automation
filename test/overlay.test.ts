import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverlay } from '../src/replay/engine.js';
import { Capability, TenantOverlay } from '../src/schema/capability.js';

const cap = Capability.parse({
  schemaVersion: '1.0', id: 'c', version: 1, name: 'n', description: 'd', status: 'verified',
  product: { id: 'p', vendor: 'v', version: '1' },
  surface: { kind: 'legacy_web', entryUrl: 'http://localhost:4310/' },
  inputs: [], outputs: [],
  steps: [
    { id: 's1', intent: 'go', action: 'navigate', url: 'http://localhost:4310/', risk: 'safe' },
    { id: 's2', intent: 'find', action: 'click', risk: 'safe',
      target: { description: 'Search', recordedRank: 0, guard: { role: 'button', name: 'Search' },
                strategies: [{ kind: 'role_name', role: 'button', name: 'Search', exact: true }] },
      waitFor: { node_visible: { role: 'button', name: 'Search' } } },
  ],
  signals: [{ id: 'g', classify: 'hard_failure', priority: 5, when: { url_matches: 'http://localhost:4310/oops' } }],
  checkpoint: { url_matches: 'http://localhost:4310/done' },
  provenance: { discoveryRunId: 'r', model: 'm', recordedAt: 'now', evidenceDir: 'e' },
});

test('an overlay rebases every recorded origin, not just the entry URL', () => {
  // Overriding entryUrl alone leaves the recorded navigate step pointing at the
  // ORIGINAL institution -- which looks like it works and drives the wrong bank.
  const { cap: merged } = applyOverlay(cap, TenantOverlay.parse({
    schemaVersion: '1.0', tenantId: 't2', institution: 'Other',
    appliesTo: { capabilityId: 'c', capabilityVersion: 1 },
    entryUrl: 'http://localhost:4311/',
  }));
  assert.equal(merged.steps[0]!.url, 'http://localhost:4311/');
  assert.deepEqual(merged.checkpoint, { url_matches: 'http://localhost:4311/done' });
  assert.ok(JSON.stringify(merged.signals).includes('4311'));
  assert.ok(!JSON.stringify(merged).includes('4310'));
});

test('an overlay can rename a control and the condition that asserts on it', () => {
  const { cap: merged, touched } = applyOverlay(cap, TenantOverlay.parse({
    schemaVersion: '1.0', tenantId: 't2', institution: 'Other',
    appliesTo: { capabilityId: 'c', capabilityVersion: 1 },
    steps: { s2: {
      target: { strategies: [{ kind: 'role_name', role: 'button', name: 'Find Member', exact: true }],
                guard: { role: 'button', name: 'Find Member' } },
      waitFor: { node_visible: { role: 'button', name: 'Find Member' } },
    } },
  }));
  assert.deepEqual(touched, ['s2']);
  assert.equal(merged.steps[1]!.target!.guard.name, 'Find Member');
  assert.deepEqual(merged.steps[1]!.waitFor, { node_visible: { role: 'button', name: 'Find Member' } });
  // the step's identity, risk and intent are untouched -- only its targeting moved
  assert.equal(merged.steps[1]!.intent, 'find');
  assert.equal(merged.steps[1]!.risk, 'safe');
});

test('tenant signals are prepended so they win ties against the product default', () => {
  const { cap: merged } = applyOverlay(cap, TenantOverlay.parse({
    schemaVersion: '1.0', tenantId: 't2', institution: 'Other',
    appliesTo: { capabilityId: 'c', capabilityVersion: 1 },
    addSignals: [{ id: 'tenant_only', classify: 'recoverable', priority: 5,
                   when: { text_present: 'Compliance Notice' },
                   recover: { do: 'wait_retry', then: 'continue', waitMs: 1, maxTimes: 1 } }],
  }));
  assert.equal(merged.signals[0]!.id, 'tenant_only');
});

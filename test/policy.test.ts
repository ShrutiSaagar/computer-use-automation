import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowed, loadPolicy } from '../src/policy/guardrails.js';

const dev = loadPolicy('policy.dev.yaml');
const prod = loadPolicy('policy.prod.yaml');

test('navigation outside the allowlist is blocked', () => {
  const d = assertAllowed({ kind: 'navigate', url: 'https://example.com/x' }, { policy: dev });
  assert.equal(d.effect, 'block');
  assert.equal(d.effect === 'block' && d.rule, 'allowedOrigins');
});

test('a session that drifts outside the allowlist is caught even without a navigate', () => {
  const d = assertAllowed({ kind: 'click', ref: 'e1' }, { policy: dev, currentUrl: 'https://evil.test/' });
  assert.equal(d.effect, 'block');
});

test('the same irreversible step is allowed in dev and gated in prod', () => {
  // The artifact is identical in both cases. Only the deployment's posture differs
  // -- which is the entire argument for keeping risk and response apart.
  assert.equal(assertAllowed({ kind: 'click', ref: 'e' }, { policy: dev, risk: 'irreversible' }).effect, 'allow');
  assert.equal(assertAllowed({ kind: 'click', ref: 'e' }, { policy: prod, risk: 'irreversible' }).effect, 'confirm');
});

test('a dangerous control is refused by name even if the step claims to be safe', () => {
  const d = assertAllowed({ kind: 'click', ref: 'e' },
    { policy: dev, risk: 'safe', controlName: 'Close Account' });
  assert.equal(d.effect, 'block');
  assert.equal(d.effect === 'block' && d.rule, 'deniedControlPatterns');
});

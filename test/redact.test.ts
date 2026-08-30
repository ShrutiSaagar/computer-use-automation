import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../src/policy/redact.js';

test('a registered secret never survives into a log line', () => {
  const r = new Redactor();
  r.addSecret('Tr0ubador-Demo-2026');
  const out = r.redact('typed Tr0ubador-Demo-2026 into the password box');
  assert.ok(!out.includes('Tr0ubador-Demo-2026'));
  assert.match(out, /⟪redacted:credential⟫/);
});

test('sensitive inputs are labelled with the parameter they came from', () => {
  const r = new Redactor();
  r.addSensitive('memberId', '100482', 'identifier');
  assert.equal(r.redact('member 100482 detail'), 'member ⟪identifier:memberId⟫ detail');
});

test('regulated shapes are caught even when nobody registered them', () => {
  const r = new Redactor();
  assert.match(r.redact('ssn 123-45-6789'), /⟪redacted:ssn⟫/);
  assert.match(r.redact('card 4111111111111111'), /⟪redacted:pan⟫/);
});

test('a long run of digits inside a number is not mistaken for a card number', () => {
  // This corrupted a real evidence file: the PAN pattern ate the fractional
  // digits of a cost float and produced `0.⟪redacted:pan⟫`, which is not JSON.
  const r = new Redactor();
  assert.equal(r.redact('cost 0.24173490000000003 usd'), 'cost 0.24173490000000003 usd');
  assert.match(r.redact('card 4111111111111111 on file'), /⟪redacted:pan⟫/);
});

test('redaction reaches nested structures, which is where evidence actually lives', () => {
  const r = new Redactor();
  r.addSecret('hunter2000');
  const out = r.redactValue({ steps: [{ note: 'used hunter2000' }], n: 1, ok: true });
  assert.ok(!JSON.stringify(out).includes('hunter2000'));
  assert.equal(out.n, 1);
  assert.equal(out.ok, true);
});

test('a short secret that is a substring of a longer one does not shred it', () => {
  const r = new Redactor();
  r.addSecret('pass');            // 4 chars, the minimum we accept
  r.addSecret('password123');
  const out = r.redact('password123');
  assert.equal(out, '⟪redacted:credential⟫');   // longest-first, not 'pass' + 'word123'
});

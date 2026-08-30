import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, CompileError, canonicaliseUrl } from '../src/learn/compile.js';
import type { DiscoveryOutcome, TraceEntry } from '../src/learn/loop.js';
import { PASSWORD_PLACEHOLDER, USERNAME_PLACEHOLDER } from '../src/learn/loop.js';
import { recorded } from './helpers.js';

const at = (seq: number, over: Partial<TraceEntry> = {}): TraceEntry => ({
  seq, tool: 'type', why: 'w', ok: true, appeared: [],
  urlBefore: 'http://a/1', urlAfter: 'http://a/1', textAfter: '',
  frameUrlsBefore: { f1: 'http://a/1' }, frameUrlsAfter: { f1: 'http://a/1' },
  element: recorded({ role: 'textbox', anchorText: 'Field' }), ...over,
});

const outcome = (over: Partial<DiscoveryOutcome>): DiscoveryOutcome => ({
  trace: [], extractions: [], finalize: null, turns: 1, blocked: [], ...over,
});

const base = {
  goal: 'g', target: 'http://a/', productId: 'none', productVendor: 'v', productVersion: '1',
  credentialRef: 'env:OP', discoveryRunId: 'r', evidenceDir: 'e', model: 'm', version: 1,
  signalPackDir: 'does-not-exist',
};

const fin = (over: Record<string, unknown> = {}) => ({
  id: 'x.y', name: 'n', description: 'd', inputs: [], steps: [], droppedSeqs: [],
  outputs: [], checkpointText: 'Done', businessOutcomes: [], ...over,
}) as never;

test('a step list with a gap is refused, naming where the flow breaks', () => {
  const trace = [
    at(0, { frameUrlsAfter: { f1: 'http://a/1' } }),
    at(1, { frameUrlsBefore: { f1: 'http://a/1' }, frameUrlsAfter: { f1: 'http://a/2' }, tool: 'click' }),
    at(2, { frameUrlsBefore: { f1: 'http://a/2' }, frameUrlsAfter: { f1: 'http://a/2' } }),
  ];
  assert.throws(
    () => compile({ ...base, outcome: outcome({ trace, finalize: fin({
      steps: [{ seq: 0, intent: 'a', risk: 'safe' }, { seq: 2, intent: 'c', risk: 'safe' }],
      droppedSeqs: [1],   // dropping the navigation leaves the survivors disconnected
    }) }) }),
    (e: Error) => e instanceof CompileError && /gap/.test(e.message),
  );
});

test('a successful action the model forgot to mention is refused', () => {
  // The frame-URL chain cannot see a dropped `type` -- it changes no URL -- so
  // full accounting is what closes that hole.
  const trace = [at(0), at(1), at(2)];
  assert.throws(
    () => compile({ ...base, outcome: outcome({ trace, finalize: fin({
      steps: [{ seq: 0, intent: 'a', risk: 'safe' }, { seq: 2, intent: 'c', risk: 'safe' }],
      droppedSeqs: [],
    }) }) }),
    (e: Error) => e instanceof CompileError && /unaccounted for/.test(e.message),
  );
});

test('recorded values become parameters and secret references, never literals', () => {
  const trace = [
    at(0, { value: USERNAME_PLACEHOLDER }),
    at(1, { value: PASSWORD_PLACEHOLDER }),
    at(2, { value: '100482' }),
  ];
  const cap = compile({ ...base, outcome: outcome({ trace, finalize: fin({
    inputs: [{ name: 'memberId', type: 'string', description: 'd', sensitivity: 'identifier', example: '100482' }],
    steps: [0, 1, 2].map((seq) => ({ seq, intent: `s${seq}`, risk: 'safe' })),
    droppedSeqs: [],
  }) }) });
  assert.deepEqual(cap.steps[0]!.value, { $secret: 'env:OP.username' });
  assert.deepEqual(cap.steps[1]!.value, { $secret: 'env:OP.password' });
  assert.deepEqual(cap.steps[2]!.value, { $param: 'memberId' });
  assert.ok(!JSON.stringify(cap).includes(PASSWORD_PLACEHOLDER.slice(2, 8)));
  // and the login steps were identified for the re-auth recovery to replay
  assert.deepEqual(cap.auth?.loginStepIds.length, 2);
});

test('credentials proposed as caller inputs are stripped, and recorded as having been', () => {
  const cap = compile({ ...base, outcome: outcome({ trace: [at(0, { value: USERNAME_PLACEHOLDER })], finalize: fin({
    inputs: [
      { name: 'operatorPassword', type: 'string', description: 'd', sensitivity: 'secret', example: PASSWORD_PLACEHOLDER },
      { name: 'memberId', type: 'string', description: 'd', sensitivity: 'identifier', example: '100482' },
    ],
    steps: [{ seq: 0, intent: 's', risk: 'safe' }], droppedSeqs: [],
  }) }) });
  assert.deepEqual(cap.inputs.map((i) => i.name), ['memberId']);
  assert.deepEqual(cap.provenance.removedCredentialInputs, ['operatorPassword']);
});

test("a parameter's own value is stripped out of the capability id", () => {
  const cap = compile({ ...base, outcome: outcome({ trace: [at(0, { value: 'Money Market' })], finalize: fin({
    id: 'member.subaccount.moneyMarket.open',
    inputs: [{ name: 'accountType', type: 'string', description: 'd', sensitivity: 'none', example: 'Money Market' }],
    steps: [{ seq: 0, intent: 's', risk: 'safe' }], droppedSeqs: [],
  }) }) });
  assert.equal(cap.id, 'member.subaccount.open');
  assert.equal(cap.provenance.declaredId, 'member.subaccount.moneyMarket.open');
});

test('an outcome detector that fires on a happy-path screen is dropped, not shipped', () => {
  // The real failure this guards against: a regex written against the permanent
  // "min $25.00" hint rather than the rejection message, which fires the instant
  // the form renders and turns a working capability into a fake business outcome.
  const cap = compile({ ...base, outcome: outcome({
    trace: [at(0, { textAfter: 'Opening Deposit  min $25.00' })],
    finalize: fin({
      steps: [{ seq: 0, intent: 's', risk: 'safe' }], droppedSeqs: [],
      businessOutcomes: [
        { code: 'TOO_LOW', message: 'm', whenTextMatches: 'min \\$', description: 'd' },
        { code: 'REAL_ONE', message: 'm', whenTextMatches: 'Opening deposit must be at least', description: 'd' },
      ],
    }),
  }) });
  assert.deepEqual(cap.signals.map((s) => s.outcome?.code), ['REAL_ONE']);
  assert.deepEqual(cap.provenance.rejectedSignals, [{ code: 'TOO_LOW', matched: 'min $' }]);
});

test('an output pattern the extracted value does not satisfy is dropped, not shipped', () => {
  // Ground truth is the value we watched the app produce. A regex that rejects it
  // is wrong, and shipping it would fail the capability on its first real call.
  const cap = compile({ ...base, outcome: outcome({
    trace: [at(0)],
    extractions: [
      { name: 'balance', value: '$4820.55', description: 'd', element: recorded({ role: 'cell' }) },
      { name: 'acct', value: '0001-100482', description: 'd', element: recorded({ role: 'cell' }) },
    ],
    finalize: fin({
      steps: [{ seq: 0, intent: 's', risk: 'safe' }], droppedSeqs: [],
      outputs: [
        // assumes thousands separators; the app does not use them
        { name: 'balance', type: 'string', description: 'd', sensitivity: 'none', pattern: '^\\$\\d{1,3}(,\\d{3})*\\.\\d{2}$' },
        { name: 'acct', type: 'string', description: 'd', sensitivity: 'none', pattern: '^\\d{4}-\\d{6}$' },
      ],
    }),
  }) });
  assert.equal(cap.outputs.find((o) => o.name === 'balance')!.pattern, undefined);
  assert.ok(cap.outputs.find((o) => o.name === 'acct')!.pattern, 'a correct pattern survives');
  assert.deepEqual(cap.provenance.rejectedOutputPatterns?.map((r) => r.output), ['balance']);
});

test('a detector is only judged against the compiled flow, not against deliberate probes', () => {
  // The agent is told to probe one read-only error state before the real flow, so
  // that screen is in the trace on purpose. Judging detectors against the whole
  // trace threw away the correct "no such member" rule for matching exactly the
  // screen the agent went to look at.
  const trace = [
    at(0, { textAfter: 'No member matching "999999" was found' }),   // the probe -- dropped
    at(1, { textAfter: 'Member Detail  Testerson, Ada Q.' }),        // the flow  -- kept
  ];
  const cap = compile({ ...base, outcome: outcome({ trace, finalize: fin({
    steps: [{ seq: 1, intent: 's', risk: 'safe' }],
    droppedSeqs: [0],
    businessOutcomes: [{ code: 'MEMBER_NOT_FOUND', message: 'm', whenTextMatches: 'No member matching', description: 'd' }],
  }) }) });
  assert.deepEqual(cap.signals.map((s) => s.outcome?.code), ['MEMBER_NOT_FOUND']);
  assert.equal(cap.provenance.rejectedSignals, undefined);
});

test('routes are canonicalised so a capability is not pinned to its example data', () => {
  assert.equal(canonicaliseUrl('http://a/member/100482/detail', ['100482']), 'http://a/member/[^/?#]+/detail');
});

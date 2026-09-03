/**
 * Composition, preconditions, and the preflight gate.
 *
 * The unit tests run with no browser (the engine's static gates and the skill
 * loader are pure of the surface); the e2e tests drive the real target app
 * through the COMPOSED path -- a capability that signs on via the auth.signon
 * skill and verifies its member precondition by delegating to the lookup skill
 * -- which is the design the brief's environment actually needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { matchVersion, loadSkills, synthesizeSessionCheck, fsLoader } from '../src/replay/skills.js';
import { buildStaticPreflight, firstGateFailure } from '../src/replay/preflight.js';
import { validateInputs } from '../src/replay/contract.js';
import { replay } from '../src/replay/engine.js';
import { Capability } from '../src/schema/capability.js';
import type { Capability as CapabilityT } from '../src/schema/capability.js';
import { loadPolicy } from '../src/policy/guardrails.js';
import { Redactor } from '../src/policy/redact.js';
import { Evidence } from '../src/evidence/logger.js';
import { FakeSurface, observation, node } from './helpers.js';
import { loadCapability } from '../src/run.js';
import { z } from 'zod';

const dir = () => mkdtempSync(join(tmpdir(), 'cua-comp-'));
const policy = () => loadPolicy('policy.dev.yaml');

/** Entry URL inside the dev policy's origin allowlist; FakeSurface.act is a
 *  no-op, so nothing actually navigates -- the allowlist check is the point. */
const cap = (p: Record<string, unknown>): CapabilityT =>
  Capability.parse({
    schemaVersion: '1.1', id: 'test.cap', version: 1, name: 't', description: 't',
    status: 'verified',
    product: { id: 'test', vendor: 'v', version: '1' },
    surface: { kind: 'web', entryUrl: 'http://localhost:4310/', deployment: 'dev' },
    inputs: [], outputs: [],
    steps: [{ id: 's1', intent: 'exist', action: 'assert' }],
    signals: [], checkpoint: { text_present: 'anything' },
    provenance: { discoveryRunId: 't', model: 't', recordedAt: new Date().toISOString(), evidenceDir: 't' },
    stats: { replays: 0, successes: 0 },
    ...p,
  });

// ---------------------------------------------------------------- the exported schema

test('capability.schema.json is the current export of the zod schema', () => {
  // `npm run schema -- --out capability.schema.json` regenerates it; this is
  // what stops the reviewable artifact format from drifting from the code.
  assert.deepEqual(JSON.parse(readFileSync('capability.schema.json', 'utf8')), z.toJSONSchema(Capability, { io: 'input' }));
});

// ---------------------------------------------------------------- version ranges

test('version ranges resolve newest-first and reject unmatched', () => {
  assert.equal(matchVersion('*', [1, 2, 3]), 3);
  assert.equal(matchVersion('^2', [1, 2, 3]), 2); // same major only: a v3 is a different contract
  assert.equal(matchVersion('>=1 <3', [1, 2, 3]), 2);
  assert.equal(matchVersion('2', [1, 2]), 2);
  assert.equal(matchVersion('>=4', [1, 2, 3]), null);
  assert.equal(matchVersion('garbage', [1]), null);
});

// ---------------------------------------------------------------- skill loading

test('loadSkills resolves transitively, detects cycles and missing skills', () => {
  const d = dir();
  try {
    // leaf -> middle -> leaf would be a cycle if middle referenced leaf's parent
    const write = (id: string, uses: unknown[]) => {
      mkdirSync(join(d, id), { recursive: true });
      writeFileSync(join(d, id, 'v1.json'), JSON.stringify(cap({
        id, uses: uses as never,
        steps: [{ id: 's1', intent: 'x', action: 'assert' }],
      })));
    };
    write('leaf', []);
    write('middle', [{ name: 'l', capabilityId: 'leaf', version: '*' }]);
    write('root', [
      { name: 'm', capabilityId: 'middle', version: '*' },
      { name: 'gone', capabilityId: 'does.not.exist', version: '*' },
      { name: 'vwrong', capabilityId: 'leaf', version: '>=99' },
    ]);

    const load = fsLoader(d);
    const ok = loadSkills(cap({ id: 'middle', uses: [{ name: 'l', capabilityId: 'leaf', version: '*' }] as never }), { load });
    assert.equal(ok.problems.length, 0);
    assert.deepEqual(ok.order, ['l=leaf@1']);

    const root = Capability.parse(JSON.parse(readFileSync(join(d, 'root', 'v1.json'), 'utf8')));
    const bad = loadSkills(root, { load });
    assert.equal(bad.problems.length, 2, bad.problems.join('; '));
    assert.match(bad.problems[0]!, /does\.not\.exist/);
    assert.match(bad.problems[1]!, />=99/);
    // the graph's slot map is flat, so one name may not mean two capabilities
    const rebound = loadSkills(cap({ id: 'root2', uses: [{ name: 'l', capabilityId: 'middle', version: '*' }] as never }), { load });
    assert.equal(rebound.problems.length, 1);
    assert.match(rebound.problems[0]!, /slot "l" is bound to middle/);

    const graph = loadSkills(
      Capability.parse(JSON.parse(readFileSync(join(d, 'root', 'v1.json'), 'utf8'))),
      { load },
    );
    assert.equal(graph.skills.size, 2); // middle + leaf resolve
    assert.ok(graph.problems.some((p) => p.includes('does.not.exist')));
    assert.ok(graph.problems.some((p) => p.includes('no version matching ">=99"')));

    // a cycle is rejected at load time, not discovered mid-run
    mkdirSync(join(d, 'cycA'), { recursive: true });
    writeFileSync(join(d, 'cycA', 'v1.json'), JSON.stringify(cap({
      id: 'cycA', uses: [{ name: 'b', capabilityId: 'cycB', version: '*' }] as never,
      steps: [{ id: 's1', intent: 'x', action: 'assert' }],
    })));
    mkdirSync(join(d, 'cycB'), { recursive: true });
    writeFileSync(join(d, 'cycB', 'v1.json'), JSON.stringify(cap({
      id: 'cycB', uses: [{ name: 'a', capabilityId: 'cycA', version: '*' }] as never,
      steps: [{ id: 's1', intent: 'x', action: 'assert' }],
    })));
    const cyclic = loadSkills(
      cap({ id: 'cycA', uses: [{ name: 'b', capabilityId: 'cycB', version: '*' }] as never }),
      { load },
    );
    assert.ok(cyclic.problems.some((p) => p.includes('cycle')));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- session check synthesis

test('session checks are synthesized from the recorded login steps for 1.0 artifacts', () => {
  const legacy = loadCapability('member.subaccount.open@1');
  const s = synthesizeSessionCheck(legacy);
  assert.ok(s, 'the v1 artifact has login steps, so a check can be derived');
  assert.deepEqual(s!.check, { node_absent: { role: 'button', name: 'Sign On' } });
  assert.deepEqual(s!.loginScreen, { node_visible: { role: 'button', name: 'Sign On' } });
});

// ---------------------------------------------------------------- static preflight

test('static preflight refuses a capability whose skill graph does not resolve', () => {
  const c = cap({
    uses: [{ name: 'ghost', capabilityId: 'no.such.skill', version: '*' }] as never,
    steps: [{ id: 's1', intent: 'x', action: 'assert' }],
  });
  const graph = loadSkills(c, { load: () => ({ versions: [], load: () => { throw new Error('x'); } }) });
  const report = buildStaticPreflight({ cap: c, policy: policy(), inputs: {}, graph });
  assert.equal(report.verdict, 'not_ready');
  assert.equal(firstGateFailure(report)?.name, 'skill_graph');
});

test('static preflight enforces the deployment tier against policy', () => {
  const c = cap({
    status: 'approved', // prod policy also requires approved; satisfy that gate
    surface: { kind: 'web', entryUrl: 'http://localhost:1/', deployment: 'sandbox' },
  });
  const prod = loadPolicy('policy.prod.yaml'); // allowedDeployments: [prod]
  const report = buildStaticPreflight({ cap: c, policy: prod, inputs: {}, graph: { skills: new Map(), order: [], problems: [] } });
  const fail = firstGateFailure(report);
  assert.equal(fail?.policyRule, 'allowedDeployments');
});

test('static preflight checks credential health across the whole graph without reading values', () => {
  const c = cap({ auth: { credentialRef: 'env:DEFINITELY_MISSING_CREDENTIALS', loginStepIds: [] } });
  const report = buildStaticPreflight({ cap: c, policy: policy(), inputs: {}, graph: { skills: new Map(), order: [], problems: [] } });
  const fail = firstGateFailure(report);
  assert.equal(fail?.name, 'credential_refs');
  assert.match(fail?.detail ?? '', /DEFINITELY_MISSING_CREDENTIALS/);
});

test('validateInputs rejects unknown inputs even when invocation metadata is present', () => {
  const c = cap({ inputs: [{ name: 'a', type: 'string', description: '', required: true }] });
  assert.equal(validateInputs(c, { a: 'x' }).ok, true);
  assert.equal(validateInputs(c, { a: 'x', invokedBy: 'agent' }).ok, false, 'metadata must be stripped by the caller first');
});

// ---------------------------------------------------------------- runtime preconditions (engine, no browser)

test('a data precondition that propagates becomes the run\u2019s business outcome', async () => {
  const surface = new FakeSurface(observation([node({ role: 'button', name: 'Search' })]));
  const evidence = new Evidence('replay', 'unit-propagate', new Redactor(), dir());
  const child = cap({
    id: 'child.check', steps: [{ id: 'c1', intent: 'x', action: 'assert' }],
    checkpoint: { text_present: 'anything' },
    signals: [{
      id: 'no_such_thing', priority: 1, classify: 'business_outcome',
      when: { text_present: 'Search' },
      outcome: { code: 'NOT_FOUND', message: 'not there' },
    }],
  });
  const parent = cap({
    id: 'parent.cap',
    uses: [{ name: 'chk', capabilityId: 'child.check', version: '*' }] as never,
    requires: {
      data: [{ name: 'exists', via: 'chk', args: {}, notMetOutcomes: ['NOT_FOUND'], onNotMet: 'propagate' }],
    },
    steps: [{ id: 's1', intent: 'x', action: 'assert' }],
  });
  const skills = new Map([['chk', { name: 'chk', ref: { name: 'chk', capabilityId: 'child.check', version: '*' }, cap: child, source: 'child.check@1' }]]);
  const r = await replay(parent, {}, { surface, policy: policy(), redactor: new Redactor(), evidence, skills, skillOrder: ['chk=child.check@1'] });
  assert.equal(r.status, 'business_outcome');
  if (r.status !== 'business_outcome') return;
  assert.equal(r.outcome.code, 'NOT_FOUND');
  assert.ok(existsSync(join(evidence.dir, 'preflight.json')), 'the refusal carries its preflight report');
  rmSync(evidence.dir, { recursive: true, force: true });
});

test('an unestablishable session requirement fails fast as precondition_not_met', async () => {
  const surface = new FakeSurface(observation([node({ role: 'button', name: 'Sign On' })]));
  const evidence = new Evidence('replay', 'unit-session', new Redactor(), dir());
  const parent = cap({
    requires: { session: { check: { node_absent: { role: 'button', name: 'Sign On' } }, onNotMet: 'fail' } },
    steps: [{ id: 's1', intent: 'x', action: 'assert' }],
  });
  const r = await replay(parent, {}, { surface, policy: policy(), redactor: new Redactor(), evidence });
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.error.class, 'precondition_not_met');
  assert.equal(r.error.stepId, '(preflight session)');
  rmSync(evidence.dir, { recursive: true, force: true });
});

test('a satisfied session requirement is telemetry, not a halt', async () => {
  // The observation has NO Sign On button, so node_absent holds immediately.
  const surface = new FakeSurface(observation([node({ role: 'link', name: 'Member Search' })]));
  const evidence = new Evidence('replay', 'unit-session-ok', new Redactor(), dir());
  const parent = cap({
    requires: { session: { check: { node_absent: { role: 'button', name: 'Sign On' } } } },
    checkpoint: { node_absent: { role: 'button', name: 'Sign On' } },
    steps: [{ id: 's1', intent: 'x', action: 'assert' }],
  });
  const r = await replay(parent, {}, { surface, policy: policy(), redactor: new Redactor(), evidence });
  assert.equal(r.status, 'success');
  rmSync(evidence.dir, { recursive: true, force: true });
});

test('a failing read-back post-condition turns a success into a postcondition_failed', async () => {
  // The checkpoint condition (text_present anything) holds; the post-condition
  // demands a node the fake surface never shows.
  const surface = new FakeSurface(observation([node({ role: 'cell', name: 'Sub-Account Opened' })]));
  const evidence = new Evidence('replay', 'unit-post', new Redactor(), dir());
  const parent = cap({
    checkpoint: { text_present: 'Sub-Account Opened' },
    post: { describe: 'the account now exists', condition: { node_visible: { role: 'cell', name: 'NOWHERE' } } },
    steps: [{ id: 's1', intent: 'x', action: 'assert' }],
  });
  const r = await replay(parent, {}, { surface, policy: policy(), redactor: new Redactor(), evidence });
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.error.class, 'postcondition_failed');
  rmSync(evidence.dir, { recursive: true, force: true });
});

test('a delegated invoke step runs the child in-session and reports its honest answer', async () => {
  const surface = new FakeSurface(observation([node({ role: 'button', name: 'Search' })]));
  const evidence = new Evidence('replay', 'unit-invoke', new Redactor(), dir());
  const child = cap({
    id: 'child.thing', steps: [{ id: 'c1', intent: 'x', action: 'assert' }],
    checkpoint: { text_present: 'anything' },
    signals: [{
      id: 'nope', priority: 1, classify: 'business_outcome',
      when: { text_present: 'Search' },
      outcome: { code: 'CHILD_SAYS_NO', message: 'the child\u2019s honest answer' },
    }],
  });
  const parent = cap({
    id: 'parent.thing',
    uses: [{ name: 'kid', capabilityId: 'child.thing', version: '*' }] as never,
    steps: [{ id: 's1', intent: 'delegate', action: 'invoke', uses: 'kid' }],
  });
  const skills = new Map([['kid', { name: 'kid', ref: { name: 'kid', capabilityId: 'child.thing', version: '*' }, cap: child, source: 'child.thing@1' }]]);
  const r = await replay(parent, {}, { surface, policy: policy(), redactor: new Redactor(), evidence, skills });
  assert.equal(r.status, 'business_outcome');
  if (r.status !== 'business_outcome') return;
  assert.equal(r.outcome.code, 'CHILD_SAYS_NO', 'a child\u2019s legitimate answer is the parent\u2019s answer');
  assert.ok(r.steps.some((s) => s.stepId.startsWith('kid:')), 'child steps appear in the parent trace, prefixed');
  assert.ok(r.flags.some((f) => f.kind === 'skill_loaded' && f.name === 'kid'));
  rmSync(evidence.dir, { recursive: true, force: true });
});

/**
 * End-to-end replay against the live target application.
 *
 * No model is involved anywhere in this file. That is the point: the production
 * path is exercised exactly as an AI agent would trigger it, and the assertions
 * are about the RESULT CONTRACT -- that a business outcome arrives as data, a
 * recoverable condition is absorbed silently, and a hard failure arrives with
 * enough detail to debug.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCapability, runReplay } from '../src/run.js';

const PORT = 4310;
const BASE = `http://localhost:${PORT}`;
const EVIDENCE = '.test-evidence';
let app: ChildProcess;
let tenantB: ChildProcess;

const chaos = (mode: string, times = 1) =>
  fetch(`${BASE}/_chaos/arm`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, times }) });
const clearChaos = () => fetch(`${BASE}/_chaos/clear`, { method: 'POST' });

const run = (inputs: Record<string, string>, label: string) =>
  runReplay(loadCapability('member.subaccount.open'), inputs, { label, headless: true })
    .then((r) => r.result);

const HAPPY = { memberNumber: '100482', accountType: 'Money Market', openingDeposit: '50.00' };

before(async () => {
  process.env.CUA_EVIDENCE_DIR = EVIDENCE;
  process.env.CU_CORE_OPERATOR_USERNAME ??= 'svc.automation';
  process.env.CU_CORE_OPERATOR_PASSWORD ??= 'Tr0ubador-Demo-2026';
  app = spawn('npx', ['tsx', 'target-app/server.ts', `--port=${PORT}`], { stdio: 'ignore' });
  tenantB = spawn('npx', ['tsx', 'target-app/server.ts', '--tenant=b', `--port=${PORT + 1}`], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    const up = await Promise.all([BASE, `http://localhost:${PORT + 1}`].map((b) =>
      fetch(`${b}/_chaos`).then(() => true).catch(() => false)));
    if (up.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`target apps did not come up on ${PORT}/${PORT + 1}`);
});

after(() => { app?.kill(); tenantB?.kill(); rmSync(EVIDENCE, { recursive: true, force: true }); });

test('the happy path replays deterministically and returns typed outputs', async () => {
  await clearChaos();
  const r = await run(HAPPY, 'e2e-happy');
  assert.equal(r.status, 'success');
  if (r.status !== 'success') return;
  assert.match(String(r.outputs.newAccountNumber), /^\d{4}-\d{6}$/);
  assert.match(String(r.outputs.effectiveDate), /^\d{4}-\d{2}-\d{2}$/);
  // every step resolved; nothing fell back to a weaker strategy than recorded
  assert.ok(r.steps.every((s) => s.status === 'ok'));
  assert.ok(!r.flags.some((f) => f.kind === 'locator_drift'));
  // and the irreversible step was flagged even though dev policy allowed it
  assert.ok(r.flags.some((f) => f.kind === 'risky_action_allowed' && f.risk === 'irreversible'));
});

test('an absent member is a business outcome, not a failure', async () => {
  await clearChaos();
  const r = await run({ ...HAPPY, memberNumber: '999999' }, 'e2e-notfound');
  assert.equal(r.status, 'business_outcome');
  if (r.status !== 'business_outcome') return;
  assert.equal(r.outcome.code, 'MEMBER_NOT_FOUND');
  assert.equal(r.outcome.data?.searchedFor, '999999');
});

test('a rejected deposit is a business outcome carrying the minimum', async () => {
  await clearChaos();
  const r = await run({ ...HAPPY, openingDeposit: '5.00' }, 'e2e-lowdeposit');
  assert.equal(r.status, 'business_outcome');
  if (r.status !== 'business_outcome') return;
  assert.equal(r.outcome.code, 'DEPOSIT_BELOW_MINIMUM');
  assert.equal(r.outcome.data?.minimum, '25.00');
});

test('a session timeout is recovered from and never reaches the caller', async () => {
  await clearChaos();
  await chaos('session_timeout');
  const r = await run(HAPPY, 'e2e-session');
  // The caller's answer is unchanged: recovery is telemetry, not a result.
  assert.equal(r.status, 'success');
  assert.ok(r.steps.some((s) => s.recoveries.some((x) => x.signalId === 'session_expired')),
    'the session_expired recovery should appear in the step trace');
});

test('an unexpected interstitial is dismissed without re-doing the step', async () => {
  await clearChaos();
  await chaos('interstitial');
  const r = await run(HAPPY, 'e2e-interstitial');
  assert.equal(r.status, 'success');
  assert.ok(r.steps.some((s) => s.recoveries.some((x) => x.signalId === 'system_notice')));
});

test('an application crash is a hard failure with expected vs observed', async () => {
  await clearChaos();
  await chaos('error500');
  const r = await run(HAPPY, 'e2e-500');
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.error.class, 'surface_error');
  assert.ok(r.error.stepId);
  assert.ok(r.error.expected.length > 0);
  assert.match(r.error.observed, /Unhandled Exception/);
});

test('a broken input contract is refused before the browser is opened', async () => {
  await clearChaos();
  const t0 = Date.now();
  const r = await run({ ...HAPPY, memberNumber: 'not-a-number' }, 'e2e-badinput');
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.error.class, 'invalid_input');
  assert.ok(Date.now() - t0 < 1000, 'should fail on the contract, not after driving a UI');
});

test('an unrecoverable state fails cleanly rather than hanging when no operator is attached', async () => {
  await clearChaos();
  await chaos('supervisor_override');
  const r = await run(HAPPY, 'e2e-nooperator');
  assert.equal(r.status, 'failed');
  if (r.status !== 'failed') return;
  assert.equal(r.error.class, 'checkpoint_failed');
  assert.match(r.error.observed, /Supervisor Override/);
  await clearChaos();
});

test('the composed run loads its skills, establishes its preconditions, and files a preflight report', async () => {
  await clearChaos();
  const { result, policy: _p } = await runReplay(loadCapability('member.subaccount.open'), HAPPY, { label: 'e2e-composed' });
  assert.equal(result.status, 'success');
  // the skills resolved and ran, pinned into the result
  assert.ok(result.skills?.includes('signon=auth.signon@1'));
  assert.ok(result.skills?.includes('lookup=member.shareSavings.lookup@2'));
  assert.ok(result.flags.some((f) => f.kind === 'skill_loaded' && f.name === 'signon'));
  assert.ok(result.flags.some((f) => f.kind === 'skill_loaded' && f.name === 'lookup'));
  // the session precondition did not hold at arrival and was ESTABLISHED
  assert.ok(result.flags.some((f) => f.kind === 'precondition_established' && f.name === 'session' && f.via.includes('signon')));
  // child steps appear in the parent's trace, prefixed by skill name
  assert.ok(result.steps.some((s) => s.stepId.startsWith('signon:') && s.status === 'ok'));
  assert.ok(result.steps.some((s) => s.stepId.startsWith('lookup:') && s.status === 'ok'));
  // the preflight report is on disk and says why every condition held
  const report = JSON.parse(readFileSync(join(result.evidenceDir, 'preflight.json'), 'utf8'));
  assert.ok(['ready', 'ready_with_flags'].includes(report.verdict));
  const byName = Object.fromEntries(report.checks.map((c: { name: string }) => [c.name, c]));
  assert.equal(byName['session']?.ok, true);
  assert.equal(byName['data.member_exists']?.ok, true);
  assert.equal(byName['deployment']?.detail, '"sandbox" is allowed by policy "dev"');
});

test('a 1.0 artifact with inline login replays through the session gate, against a second tenant via overlay', async () => {
  // v1 carries its own login steps. The preflight establishes the session by
  // running them, so the flow must START after them -- replaying "navigate to
  // the sign-on screen" against a signed-on session is the regression this guards.
  const { result: r } = await runReplay(loadCapability('member.subaccount.open@1'),
    { memberNumber: '100483', accountType: 'Holiday Club', openingDeposit: '75.00' },
    { label: 'e2e-northstar-v1', headless: true, overlayPath: 'capabilities/member.subaccount.open/northstar-fcu.overlay.json' });
  assert.equal(r.status, 'success', JSON.stringify(r.status === 'failed' ? r.error : r.status));
  if (r.status !== 'success') return;
  assert.match(String(r.outputs.newAccountNumber), /^\d{4}-\d{6}$/);
  assert.ok(r.flags.some((f) => f.kind === 'overlay_applied' && f.tenantId === 'northstar-fcu'));
  assert.ok(r.flags.some((f) => f.kind === 'precondition_established' && f.name === 'session' && f.via === 'inline login steps'));
  // no login step ran twice: the trace starts at the first post-login step
  assert.equal(r.steps[0]?.stepId, 's5_member_no');
});

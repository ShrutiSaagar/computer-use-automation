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
import { rmSync } from 'node:fs';
import { loadCapability, runReplay } from '../src/run.js';

const PORT = 4310;
const BASE = `http://localhost:${PORT}`;
const EVIDENCE = '.test-evidence';
let app: ChildProcess;

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
  for (let i = 0; i < 40; i++) {
    if (await fetch(`${BASE}/_chaos`).then(() => true).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`target app did not come up on ${PORT}`);
});

after(() => { app?.kill(); rmSync(EVIDENCE, { recursive: true, force: true }); });

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

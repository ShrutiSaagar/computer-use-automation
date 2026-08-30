import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLadder, resolveLocator } from '../src/replay/locator.js';
import { FakeSurface, node, observation, recorded } from './helpers.js';

test('a named control leads with role+name; an unnamed one leads with the caption anchor', () => {
  const named = buildLadder(recorded({ role: 'button', name: 'Search', id: 'ctl00_x_btnSearch' }), 'search');
  assert.equal(named.strategies[0]!.kind, 'role_name');

  // The legacy case: no label, no accessible name. role_name is not merely
  // lower-ranked, it must be absent -- there is nothing for it to match on.
  const bare = buildLadder(recorded({ role: 'textbox', anchorText: 'Member No.', id: 'ctl00_x_txtMbrNo' }), 'member');
  assert.equal(bare.strategies[0]!.kind, 'anchor');
  assert.ok(!bare.strategies.some((s) => s.kind === 'role_name'));
});

test('an id ladder tolerates a shifted container prefix', () => {
  const l = buildLadder(recorded({ role: 'textbox', id: 'ctl00_ContentPlaceHolder1_txtDeposit', anchorText: 'Deposit' }), 'd');
  const idp = l.strategies.find((s) => s.kind === 'id_pattern');
  assert.ok(idp && 'regex' in idp);
  assert.match('ctl00_SOMETHING_ELSE_txtDeposit', new RegExp((idp as { regex: string }).regex));
});

test('an output locator never keys on the value it is there to read', () => {
  // Guarding on the recorded value would reject every future run that returns a
  // different -- correct -- answer.
  const l = buildLadder(recorded({ role: 'cell', name: '0003-100482', anchorText: 'New Account Number' }), 'acct', undefined, 'output');
  assert.equal(l.strategies[0]!.kind, 'anchor');
  assert.equal(l.guard.name, undefined);
  assert.ok(!JSON.stringify(l.strategies).includes('0003-100482'));
});

test('the anchor strategy counts controls in reading order', async () => {
  const obs = observation([
    node({ role: 'cell', name: 'Opening Deposit', ref: 'a1' }),
    node({ role: 'textbox', ref: 'want' }),
    node({ role: 'cell', name: 'Notes', ref: 'a2' }),
    node({ role: 'textbox', ref: 'other' }),
  ]);
  const l = buildLadder(recorded({ role: 'textbox', anchorText: 'Opening Deposit' }), 'deposit');
  const r = await resolveLocator(l, obs, new FakeSurface(obs));
  assert.ok(r.ok && r.ref === 'want');
});

test('the guard rejects a stale strategy that resolves to the wrong control', async () => {
  // css still matches something -- but something with the wrong identity. Acting
  // on it would be worse than failing, so the ladder must fall through.
  const obs = observation([node({ role: 'link', name: 'Delete member', ref: 'wrong' })]);
  const surface = new FakeSurface(obs, { 'css:form > input': ['wrong'] });
  const r = await resolveLocator({
    description: 'the Search button',
    strategies: [{ kind: 'css', value: 'form > input' }],
    recordedRank: 0,
    guard: { role: 'button', name: 'Search' },
  }, obs, surface);
  assert.ok(!r.ok);
  assert.equal(r.reason, 'guard_mismatch');
  assert.match(r.detail, /Delete member/);
});

test('an ambiguous match is refused rather than guessed at', async () => {
  const obs = observation([
    node({ role: 'button', name: 'Continue', ref: 'c1' }),
    node({ role: 'button', name: 'Continue', ref: 'c2' }),
  ]);
  const r = await resolveLocator({
    description: 'Continue', recordedRank: 0, guard: { role: 'button', name: 'Continue' },
    strategies: [{ kind: 'role_name', role: 'button', name: 'Continue', exact: true }],
  }, obs, new FakeSurface(obs));
  assert.ok(!r.ok);
  assert.equal(r.reason, 'ambiguous');
});

test('falling further down the ladder than at record time is reported as drift', async () => {
  const obs = observation([node({ role: 'textbox', ref: 'x' }), node({ role: 'cell', name: 'Member No.', ref: 'a' })]);
  obs.nodes[0]!.index = 1; obs.nodes[1]!.index = 0;
  const r = await resolveLocator({
    description: 'member field', recordedRank: 0, guard: { role: 'textbox' },
    strategies: [
      { kind: 'role_name', role: 'textbox', name: 'Member Number', exact: true },
      { kind: 'anchor', anchorText: 'Member No.', role: 'textbox', ordinal: 0 },
    ],
  }, obs, new FakeSurface(obs));
  assert.ok(r.ok);
  assert.equal(r.rank, 1);              // rank 0 no longer matches
  assert.ok(r.rank > 0);                // which is what the engine flags as drift
});

test('coordinates are denormalised against the OBSERVED viewport, not a remembered one', async () => {
  // The bug this guards against: the resolver hardcoded 1280x800, which happened
  // to be correct only because the launcher hardcoded the same numbers somewhere
  // else. Change the window size and clicks land on the wrong control silently.
  const target = node({ role: 'button', name: 'x', ref: 'want', box: { x: 790, y: 590, w: 20, h: 20 } });
  const decoy  = node({ role: 'button', name: 'x', ref: 'decoy', box: { x: 630, y: 390, w: 20, h: 20 } });
  const loc = { description: 'b', recordedRank: 0, guard: { role: 'button' },
                strategies: [{ kind: 'coords' as const, nx: 0.5, ny: 0.5 }] };

  // Centre of a 1600x1200 window is (800, 600) -> the target, not the decoy.
  const big = observation([target, decoy], { viewport: { w: 1600, h: 1200 } });
  const rBig = await resolveLocator(loc, big, new FakeSurface(big), { allowCoordinateFallback: true });
  assert.ok(rBig.ok && rBig.ref === 'want');

  // Centre of a 1280x800 window is (640, 400) -> the decoy. Same locator, same
  // nodes, different viewport, correctly different answer.
  const small = observation([target, decoy], { viewport: { w: 1280, h: 800 } });
  const rSmall = await resolveLocator(loc, small, new FakeSurface(small), { allowCoordinateFallback: true });
  assert.ok(rSmall.ok && rSmall.ref === 'decoy');
});

test('coordinate fallback stays off unless policy opts in', async () => {
  const obs = observation([node({ role: 'button', name: 'x', ref: 'b', box: { x: 630, y: 390, w: 40, h: 20 } })],
    { viewport: { w: 1280, h: 800 } });
  const loc = { description: 'b', recordedRank: 0, guard: { role: 'button' },
                strategies: [{ kind: 'coords' as const, nx: 0.5, ny: 0.5 }] };
  assert.ok(!(await resolveLocator(loc, obs, new FakeSurface(obs))).ok);
  assert.ok((await resolveLocator(loc, obs, new FakeSurface(obs), { allowCoordinateFallback: true })).ok);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, matchSignals } from '../src/replay/detect.js';
import type { Signal } from '../src/schema/capability.js';
import { FakeSurface, node, observation } from './helpers.js';

const sig = (o: Partial<Signal> & { id: string; classify: Signal['classify'] }): Signal =>
  ({ priority: 100, when: { text_present: 'x' }, ...o } as Signal);

test('url_matches looks inside frames, because a frameset freezes the top URL', async () => {
  const obs = observation([], {
    url: 'http://localhost:4310/',
    frameUrls: { f1: 'http://localhost:4310/', f3: 'http://localhost:4310/content/member/100482' },
    frameOrder: ['f1', 'f3'],
  });
  const s = new FakeSurface(obs);
  assert.ok(await evaluateCondition({ url_matches: '/content/member/' }, obs, s));
  // ...but 'main' still means the top document only.
  assert.ok(!(await evaluateCondition({ url_matches: '/content/member/', frame: 'main' }, obs, s)));
});

test('signals fire in priority order, not array order', async () => {
  const obs = observation([node({ role: 'generic', text: 'Unhandled Exception and also No member matching "1" was found' })]);
  const hits = await matchSignals([
    sig({ id: 'not_found', classify: 'business_outcome', priority: 10, when: { text_present: 'No member matching' },
          outcome: { code: 'MEMBER_NOT_FOUND', message: 'nope' } }),
    sig({ id: 'crash', classify: 'hard_failure', priority: 5, when: { text_present: 'Unhandled Exception' } }),
  ], obs, new FakeSurface(obs));
  assert.equal(hits[0]!.signal.id, 'crash');   // priority 5 beats 10
});

test('capture groups become caller-visible outcome data', async () => {
  const obs = observation([node({ role: 'generic', text: 'Opening deposit must be at least $25.00 for this product.' })]);
  const hits = await matchSignals([
    sig({ id: 'min', classify: 'business_outcome',
          when: { text_matches: 'Opening deposit must be at least \\$([0-9.]+)' },
          outcome: { code: 'DEPOSIT_BELOW_MINIMUM', message: 'too low', capture: { minimum: 1 } } }),
  ], obs, new FakeSurface(obs));
  assert.equal(hits[0]!.captured.minimum, '25.00');
});

test('all/any/not compose', async () => {
  const obs = observation([node({ role: 'button', name: 'Open Account' })]);
  const s = new FakeSurface(obs);
  assert.ok(await evaluateCondition({ all: [{ node_visible: { role: 'button', name: 'Open Account' } }, { not: { text_present: 'nope' } }] }, obs, s));
  assert.ok(await evaluateCondition({ any: [{ text_present: 'nope' }, { node_visible: { role: 'button' } }] }, obs, s));
  assert.ok(await evaluateCondition({ node_absent: { role: 'combobox' } }, obs, s));
});

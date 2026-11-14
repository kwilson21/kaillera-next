import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createComparer, DISAGREE_LIMIT, type DisagreeReport } from '../../web/src/play/observe.ts';

const collecting = (ready = () => true) => {
  const sent: DisagreeReport[] = [];
  const comparer = createComparer((report) => {
    if (!ready()) return false;
    sent.push(report);
    return true;
  });
  return { sent, comparer };
};

test('agreement reports nothing', () => {
  const { sent, comparer } = collecting();
  assert.equal(comparer.compare('delay-preference', 3, 3), true);
  assert.equal(comparer.compare('remap-wizard', { step: 1, keys: { 65: 0 } }, { step: 1, keys: { 65: 0 } }), true);
  assert.equal(comparer.compare('nothing', undefined, undefined), true);
  assert.deepEqual(sent, []);
});

test('a disagreement is reported with what each side decided', () => {
  const { sent, comparer } = collecting();
  assert.equal(comparer.compare('delay-preference', 2, 3), false);
  assert.deepEqual(sent, [{ type: 'play-disagree', message: 'delay-preference', old: '2', next: '3' }]);
});

test('the same disagreement is reported once', () => {
  const { sent, comparer } = collecting();
  for (let i = 0; i < 50; i++) comparer.compare('delay-preference', 2, 3);
  comparer.compare('delay-preference', 2, 4);
  assert.deepEqual(
    sent.map((r) => r.next),
    ['3', '4'],
  );
});

test('a page reports a bounded number of different disagreements', () => {
  const { sent, comparer } = collecting();
  for (let i = 0; i < DISAGREE_LIMIT * 3; i++) comparer.compare('delay-preference', 0, i + 1);
  assert.equal(sent.length, DISAGREE_LIMIT);
});

test('reports wait until they can be sent, then go in order', () => {
  let ready = false;
  const { sent, comparer } = collecting(() => ready);
  comparer.compare('delay-preference', 2, 3);
  comparer.compare('remap-wizard', 'a', 'b');
  assert.equal(sent.length, 0);
  ready = true;
  // Any later comparison, agreeing or not, sends what is waiting.
  comparer.compare('delay-preference', 5, 5);
  assert.deepEqual(
    sent.map((r) => r.message),
    ['delay-preference', 'remap-wizard'],
  );
  comparer.flush();
  assert.equal(sent.length, 2);
});

test('long values are compared whole and reported around the first difference', () => {
  const { sent, comparer } = collecting();
  const long = 'x'.repeat(5000);
  assert.equal(comparer.compare('remap-wizard', long, long), true);
  assert.equal(comparer.compare('remap-wizard', `${long}A`, `${long}B`), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.old.length, 300);
  assert.ok(sent[0]?.old.endsWith('A"'));
  assert.ok(sent[0]?.next.endsWith('B"'));
});

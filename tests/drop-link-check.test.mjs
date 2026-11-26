import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldPredictionAfterReset, reconnectSyncWindow } from './drop-link-check.mjs';

const correction = (slot, tag) => '10\t2222.1\tf=1200\t[C] MISPREDICTION slot=' + slot + ' f=' + tag + ' target=19';

test('only the selected guest’s held pre-close tag proves its prediction survived', () => {
  const first = correction(1, 1115);
  assert.equal(heldPredictionAfterReset([correction(1, 1160), first], 1, 1115, 1117), first);
  assert.equal(heldPredictionAfterReset([correction(2, 1115), correction(1, 1160)], 1, 1115, 1117), null);
});

test('a wait that timed out or did not reach three held tags cannot prove the fault', () => {
  assert.equal(heldPredictionAfterReset([correction(1, 1115)], 1, 1115, -1), null);
  assert.equal(heldPredictionAfterReset([correction(1, 1115)], 1, 1115, 1116), null);
});

const line = (message) => `10\t2222.1\tf=1200\t${message}`;
const applied = (from, to) => line(`sync #3 applied (frame ${from} -> ${to}, next in 10f)`);

test('a scoped reconnect proof and its matching apply bound the outage', () => {
  const proof = line('RECONNECT-ANSWER-APPLIED f=1199 request=2');
  assert.deepEqual(
    reconnectSyncWindow(
      [applied(1185, 1185), proof, applied(1190, 1192), applied(1199, 1209), applied(1208, 1213)],
      1161,
    ),
    { from: 1161, to: 1209, route: 'proof' },
  );
  assert.deepEqual(reconnectSyncWindow([proof, applied(1190, 1192)], 1161), { from: 1161, to: null, route: 'proof' });
});

test('a legacy reconnect still allows a nearby corrective follow-up', () => {
  const sent = line('reconnect resync: sent sync-request-full request=2');
  assert.deepEqual(reconnectSyncWindow([sent, applied(1199, 1209), applied(1200, 1219), applied(1220, 1240)], 1161), {
    from: 1161,
    to: 1219,
    route: 'legacy',
  });
});

test('an unsolicited resync alone cannot mark reconnect recovery', () => {
  assert.deepEqual(reconnectSyncWindow([applied(1199, 1209)], 1161), { from: 1161, to: null, route: null });
});

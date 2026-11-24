import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldPredictionAfterReset } from './drop-link-check.mjs';

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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextWakeView, wakeDotColumns } from '../../web/src/wake-art.ts';

test('waking art cycles through A, C, B, then back to A', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => nextWakeView(index, 3)),
    [1, 2, 0, 1],
  );
});

test('dot columns clamp to one through forty and use the dot spacing', () => {
  assert.equal(wakeDotColumns(0), 1);
  assert.equal(wakeDotColumns(22), 1);
  assert.equal(wakeDotColumns(35), 2);
  assert.equal(wakeDotColumns(10000), 40);
});

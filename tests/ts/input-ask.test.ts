import { test } from 'node:test';
import assert from 'node:assert/strict';

import { framesToAskFor } from '../../web/src/input-ask.ts';
import { KNCore } from '../../web/src/index.ts';

const holes = (from: number, through: number, missing: readonly number[]): boolean[] => {
  const have: boolean[] = [];
  for (let f = from; f <= through; f++) have.push(!missing.includes(f));
  return have;
};

test('a page asks for the inputs it waits for that the peer has made', () => {
  // The run that found it: the guest dropped the host's 217..226 while far
  // behind, then received 227 on. Stalled at the window's edge 217, applying 224.
  const have = holes(217, 224, [217, 218, 219, 220, 221, 222, 223, 224]);
  assert.deepEqual(framesToAskFor(have, 217, 224, 237, 32), [217, 218, 219, 220, 221, 222, 223, 224]);
});

test('it does not ask for an input the peer is not known to have made', () => {
  // Behind: the peer's newest is 219, and nothing newer was dropped.
  const have = holes(215, 224, [220, 221, 222, 223, 224]);
  assert.deepEqual(framesToAskFor(have, 215, 224, 219, 32), []);
  // With 222 known (received or dropped), up to 222.
  assert.deepEqual(framesToAskFor(have, 215, 224, 222, 32), [220, 221, 222]);
});

test('it asks only for holes, oldest first, and at most max', () => {
  const have = holes(100, 110, [101, 104, 105, 109]);
  assert.deepEqual(framesToAskFor(have, 100, 110, 120, 32), [101, 104, 105, 109]);
  assert.deepEqual(framesToAskFor(have, 100, 110, 120, 2), [101, 104]);
  assert.deepEqual(framesToAskFor(have, 100, 110, 120, 0), []);
});

test('nothing missing, nothing asked', () => {
  assert.deepEqual(framesToAskFor(holes(5, 9, []), 5, 9, 30, 32), []);
});

test('the plain-script engine reaches it through KNCore', () => {
  assert.equal(KNCore.framesToAskFor, framesToAskFor);
});

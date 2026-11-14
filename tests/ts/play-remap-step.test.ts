import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepAfter, stepVerdict, type InputKind, type StepKind } from '../../web/src/play/remap-step.ts';

// The contracts on these two functions are proved (LemmaScript, Dafny); this
// runs the same statements over every small case, so a failure here reads as
// plain values instead of a proof error.

const STEP_KINDS: readonly StepKind[] = ['button', 'axis', 'cbutton'];
const INPUT_KINDS: readonly InputKind[] = ['button', 'axis', 'key', 'skip'];

test('every small case meets the contract', () => {
  let cases = 0;
  for (const stepKind of STEP_KINDS) {
    for (const input of INPUT_KINDS) {
      for (const hasPad of [true, false]) {
        for (const pairedAxis of [-1, 0, 1]) {
          for (const inputAxis of [0, 1]) {
            for (const step of [0, 1, 2]) {
              const verdict = stepVerdict(stepKind, input, hasPad, pairedAxis, inputAxis, step, 3);
              const pad = input === 'button' || input === 'axis';
              const wrong =
                hasPad && input === 'axis' && stepKind === 'axis' && pairedAxis >= 0 && pairedAxis !== inputAxis;
              if (!pad) assert.ok(verdict === 'advance' || verdict === 'done');
              if (pad && !hasPad) assert.equal(verdict, 'ignore');
              if (input === 'button' && stepKind === 'axis') assert.equal(verdict, 'ignore');
              if (input === 'axis' && stepKind === 'button') assert.equal(verdict, 'ignore');
              assert.equal(verdict === 'wrongStick', wrong);
              if (verdict === 'done') assert.equal(step, 2);
              if (verdict === 'advance') assert.ok(step < 2);
              assert.equal(stepAfter(step, verdict), verdict === 'advance' || verdict === 'done' ? step + 1 : step);
              cases++;
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 432);
});

test('a C button step takes a button or a stick, whichever axis', () => {
  assert.equal(stepVerdict('cbutton', 'button', true, -1, -1, 0, 3), 'advance');
  assert.equal(stepVerdict('cbutton', 'axis', true, -1, 2, 0, 3), 'advance');
});

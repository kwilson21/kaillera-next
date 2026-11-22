import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESET_COMBO_MASK, resetComboActive } from '../../web/src/reset-combo.ts';

test('reset uses the controller chord, not Start or an emulator reset', () => {
  assert.equal(RESET_COMBO_MASK, 6147);
  assert.equal(RESET_COMBO_MASK & (1 << 3), 0);
});

test('reset is active only during a deliberate hold in a running game', () => {
  for (const open of [false, true])
    for (const held of [false, true])
      for (const playing of [false, true]) {
        assert.equal(resetComboActive(open, held, playing), open && held && playing);
      }
});

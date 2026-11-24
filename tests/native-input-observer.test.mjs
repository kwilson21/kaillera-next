import test from 'node:test';
import assert from 'node:assert/strict';
import { installNativeInputObserver } from './native-input-observer.mjs';
test('observer preserves calls/results and records actual getter outputs with snapshot sequence', () => {
  let frame = 100,
    js = 100;
  const calls = [];
  const mod = {
    HEAP32: new Int32Array(20),
    _kn_get_frame: () => frame,
    _kn_set_frame: (n) => {
      frame = n;
      return 81;
    },
    _kn_pre_tick: (...a) => {
      calls.push(a);
      return 0;
    },
    _kn_get_input: (slot, key, ...p) => {
      p.forEach((ptr, i) => (mod.HEAP32[ptr >> 2] = slot * 100 + key + i));
      return 1;
    },
  };
  const observer = installNativeInputObserver(mod, () => ({ currentFrame: js, delay: 3 }), 2, 1);
  assert.equal(mod._kn_set_frame(90), 81);
  js = 90;
  assert.equal(mod._kn_pre_tick(1, 2, 3, 4, 5, -1), 0);
  assert.deepEqual(calls, [[1, 2, 3, 4, 5, -1]]);
  for (let slot = 0; slot < 2; slot++) assert.equal(mod._kn_get_input(slot, 87, 0, 4, 8, 12, 16), 1);
  const out = observer.export();
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].sequence, 1);
  assert.deepEqual(out.rows[0].inputs[1], { present: true, values: [187, 188, 189, 190, 191] });
  assert.equal(out.rows[0].pre.nativeFrame, 90);
  assert.equal(out.rows[0].post.jsFrame, 90);
  mod._kn_pre_tick();
  for (let s = 0; s < 2; s++) mod._kn_get_input(s, 87, 0, 4, 8, 12, 16);
  assert.equal(observer.export().overflow, 1);
  assert.equal(observer.export().rows.length, 1);
});

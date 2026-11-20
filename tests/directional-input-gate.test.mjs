import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectionalInputGate, catchUpHoleInput } from './directional-input-gate.mjs';
const packet = (frame, red = []) =>
  new Int32Array([
    frame,
    frame + 1,
    frame + 2,
    frame + 3,
    77,
    red.length,
    ...red.flatMap((f) => [f, f + 1, f + 2, f + 3]),
  ]).buffer;
const records = (data) => {
  const w = Array.from(new Int32Array(data));
  return [w.slice(0, 4), ...Array.from({ length: w[5] ?? 0 }, (_, i) => w.slice(6 + i * 4, 10 + i * 4))];
};
test('only pinned records withheld, even when primary or redundant inside a later packet', () => {
  const got = [];
  const gate = createDirectionalInputGate({ target: (c) => c === 'p2', now: () => 10 });
  const send = (f, red = [], ch = 'p2') =>
    gate.receive(ch, packet(f, red), (data) => {
      assert.equal(new Int32Array(data)[4], 77);
      for (const r of records(data)) {
        assert.deepEqual(r, [r[0], r[0] + 1, r[0] + 2, r[0] + 3]);
        got.push(r[0]);
      }
    });
  gate.arm(2);
  send(101, [100]);
  send(104, [103, 102, 101]);
  send(110, [], 'p1');
  gate.pin(101, 102);
  assert.deepEqual(got, [110, 100, 104, 103, 102]);
  send(112, [111, 110, 101]);
  send(101, [99]);
  assert.deepEqual(got, [110, 100, 104, 103, 102, 112, 111, 110, 99]);
  assert.deepEqual(gate.stats().queuedFrames, [101, 101, 101, 101]);
  assert.throws(() => gate.release(100));
  gate.release(101);
  assert.deepEqual(got.slice(-4), [101, 101, 101, 101]);
  assert.equal(gate.stats().held, 4);
});
test('unselected peers, controls, malformed payloads and disarmed traffic pass unchanged', () => {
  const gate = createDirectionalInputGate({ target: (c) => c === 'p2', now: () => 1 });
  const data = packet(101);
  gate.receive('p2', data, (p) => assert.equal(p, data));
  gate.arm(2);
  gate.pin(101, 102);
  for (const value of ['ping', new ArrayBuffer(4), new ArrayBuffer(17)])
    gate.receive('p2', value, (p) => assert.equal(p, value));
  gate.receive('p1', data, (p) => assert.equal(p, data));
  assert.equal(gate.stats().queued, 0);
});
test('deep selection reflects actual Mac delay and near-window boundary', () => {
  assert.equal(catchUpHoleInput(1052, 7, true), 1045);
  assert.equal(catchUpHoleInput(1052, 7, false), 1052);
  assert.equal(1052 + 7 >= 1066 - 7, true);
  assert.equal(1045 + 7 < 1066 - 7, true);
  assert.throws(() => catchUpHoleInput(1052, NaN, true));
});

test('explicit burst mode retains whole original packets and is reported separately', () => {
  const gate = createDirectionalInputGate({ target: () => true, now: () => 1 }),
    got = [];
  gate.arm(2, 'burst');
  gate.pin(101, 102);
  const data = packet(104, [103, 102, 101]);
  gate.receive('p2', data, (p) => got.push(p));
  assert.equal(got.length, 0);
  assert.equal(gate.stats().mode, 'burst');
  assert.deepEqual(gate.stats().queuedFrames, [104, 103, 102, 101]);
  gate.release(101);
  assert.equal(got[0], data);
});

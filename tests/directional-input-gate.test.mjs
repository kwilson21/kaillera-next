import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectionalInputGate } from './directional-input-gate.mjs';
const packet = (frame, redundant = []) =>
  new Int32Array([frame, 1, 2, 3, -1, redundant.length, ...redundant.flatMap((f) => [f, 4, 5, 6])]).buffer;
function fixture() {
  const delivered = [];
  let time = 1;
  const gate = createDirectionalInputGate({ target: (ch, slot) => ch === `p${slot}`, now: () => time++ });
  const send = (frame, redundant = [], channel = 'p2') => {
    const data = packet(frame, redundant),
      before = Array.from(new Uint8Array(data));
    gate.receive(channel, data, () => {
      assert.deepEqual(Array.from(new Uint8Array(data)), before);
      delivered.push(frame);
    });
  };
  return { gate, send, delivered };
}
test('pin retains primary, redundant and resend carriers while other peers and later heartbeat pass', () => {
  const { gate, send, delivered } = fixture();
  gate.arm(2);
  send(100);
  send(101);
  send(102, [101]);
  send(103);
  send(101, [], 'p1');
  assert.deepEqual(delivered, [101]);
  gate.pin(101, 102);
  assert.deepEqual(delivered, [101, 100, 103]);
  send(101);
  send(104, [101]);
  send(120);
  assert.equal(gate.stats().queued, 4);
  assert.equal(gate.stats().laterInputs, 2);
  assert.throws(() => gate.release(100));
  assert.equal(gate.stats().releasedAt, null);
  gate.release(101);
  assert.equal(gate.stats().held, 4);
  assert.deepEqual(delivered, [101, 100, 103, 120, 101, 102, 101, 104]);
  send(101);
  assert.equal(delivered.at(-1), 101);
});
test('controls, ACKs and malformed/non-input traffic never enter the input gate', () => {
  const { gate } = fixture();
  gate.arm(2);
  gate.pin(100, 101);
  let delivered = 0;
  for (const data of ['inputs-settled:100', 'ping', new ArrayBuffer(4), new ArrayBuffer(17)])
    gate.receive('p2', data, () => delivered++);
  assert.equal(delivered, 4);
  assert.equal(gate.stats().queued, 0);
});
test('nothing is delayed before arming and gate never releases on its own', async () => {
  const { gate, send, delivered } = fixture();
  send(101);
  gate.arm(2);
  gate.pin(101, 102);
  send(101);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(delivered, [101]);
  assert.equal(gate.stats().releasedAt, null);
});

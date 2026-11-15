// Run: node --test tests/link-schedule.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutLinkStarved } from './frozen-recovery.mjs';
import { createLinkSchedule, frameAtTime, spansInFrames } from './link-schedule.mjs';

// Delivered messages, as [time, label, data], by stepping the clock through every wake.
const run = (net, l, until) => {
  const out = [];
  for (let now = 0; ;) {
    for (const ch of l.channels) for (const data of net.take(ch, now)) out.push([now, ch.label, data]);
    const next = net.wakeAt(l, now);
    if (next === Infinity || next > until) return out;
    now = next;
  }
};

test('without a rate, a message arrives after the latency, and jitter never reorders a channel', () => {
  let r = 0;
  const randoms = [0.9, 0.1, 0.5];
  const net = createLinkSchedule({ lat: 50, jitter: 20, random: () => randoms[r++] });
  const l = net.link();
  const a = net.channel(l, 'lockstep');
  net.send(a, 'x', 1, 0, 0);
  net.send(a, 'y', 1, 0, 0);
  net.send(a, 'z', 1, 0, 1);
  assert.deepEqual(run(net, l, 1000), [
    [68, 'lockstep', 'x'],
    [68, 'lockstep', 'y'],
    [68, 'lockstep', 'z'],
  ]);
});

test('inputs on another channel of the same connection wait behind a state', () => {
  // 8 kbit/s: one byte a millisecond.
  const net = createLinkSchedule({ kbps: 8 });
  const l = net.link();
  const sync = net.channel(l, 'sync-state');
  const input = net.channel(l, 'rollback-input');
  net.send(sync, 'chunk1', 1000, 0, 0);
  net.send(sync, 'chunk2', 1000, 0, 0);
  net.send(input, 'i1', 10, 0, 5);
  assert.equal(net.unsent(input, 5), 10);
  assert.equal(net.queued(sync), 2000);
  assert.deepEqual(run(net, l, 10000), [
    [1000, 'sync-state', 'chunk1'],
    [2000, 'sync-state', 'chunk2'],
    [2010, 'rollback-input', 'i1'],
  ]);
  assert.equal(net.unsent(input, 2010), 0);
  assert.equal(net.stats.byLabel['rollback-input'].maxQueueMs, 2005);
  assert.equal(net.stats.byLabel['rollback-input'].starved, 1);
  assert.deepEqual(net.stats.byLabel['rollback-input'].starvedSpans, [{ from: 5, to: 2010 }]);
  // chunk1 is on the link by then; chunk2 and the input wait for it.
  assert.equal(net.stats.maxBacklogBytes, 1010);
});

test('connections do not share a link', () => {
  const net = createLinkSchedule({ kbps: 8 });
  const l1 = net.link();
  const l2 = net.link();
  net.send(net.channel(l1, 'sync-state'), 'big', 5000, 0, 0);
  const other = net.channel(l2, 'lockstep');
  net.send(other, 'i', 10, 0, 0);
  assert.deepEqual(run(net, l2, 10000), [[10, 'lockstep', 'i']]);
});

test('a held message holds its own channel, not the others, and takes the link only when released', () => {
  const net = createLinkSchedule({ kbps: 8 });
  const l = net.link();
  const sync = net.channel(l, 'sync-state');
  const input = net.channel(l, 'lockstep');
  net.send(sync, 'answer', 100, 1000, 0);
  net.send(sync, 'chunk', 1000, 0, 0);
  net.send(input, 'early', 10, 0, 10);
  net.send(input, 'late', 10, 0, 1050);
  assert.deepEqual(run(net, l, 10000), [
    [20, 'lockstep', 'early'],
    [1100, 'sync-state', 'answer'],
    [2100, 'sync-state', 'chunk'],
    [2110, 'lockstep', 'late'],
  ]);
});

test('a message already on the link is not overtaken', () => {
  const net = createLinkSchedule({ kbps: 8 });
  const l = net.link();
  const sync = net.channel(l, 'sync-state');
  const input = net.channel(l, 'lockstep');
  net.send(sync, 'chunk', 1000, 0, 0);
  assert.deepEqual(run(net, l, 500), []);
  net.send(input, 'i', 10, 0, 500);
  assert.deepEqual(run(net, l, 10000), [
    [1000, 'sync-state', 'chunk'],
    [1010, 'lockstep', 'i'],
  ]);
});

test('a page time maps to the frame its sync log was on', () => {
  const log = '1\t100.0\tf=10\ta\n2\t200.0\tf=20\tb\n3\t300.0\tf=30\tc\n';
  assert.equal(frameAtTime(log, 50), 10);
  assert.equal(frameAtTime(log, 250), 20);
  assert.equal(frameAtTime(log, 999), 30);
  assert.deepEqual(spansInFrames(log, [{ from: 150, to: 310 }]), [{ from: 10, to: 30 }]);
});

test('a phantom of a page whose inputs were starved on the link is not a proven frozen page', () => {
  const recovery = { declaredBy: 'guest', from: 177, to: 214, stoppedPage: 'host', stoppedMs: 5204, proven: true };
  assert.deepEqual(withoutLinkStarved([recovery], { host: [{ from: 150, to: 190 }], guest: [] }), [
    { ...recovery, proven: false, linkStarved: true },
  ]);
  // The other page's starved inputs, or a span long before, change nothing.
  assert.deepEqual(withoutLinkStarved([recovery], { host: [{ from: 10, to: 40 }], guest: [{ from: 150, to: 190 }] }), [
    recovery,
  ]);
});

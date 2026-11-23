// tests/join-input-check.mjs: what each page applied around a join, read
// from its sync log, and whether the pages agree.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appliedForTag, joinInputAgreement, joinStateFrame } from './join-input-check.mjs';

let seq = 0;
const line = (frame, text) => `${seq++}\t0\tf=${frame}\t${text}`;
const tr = (frame, delay, inputs) =>
  line(
    frame,
    `NORMAL-INPUT-TR f=${frame} apply=${frame - delay} ` +
      inputs.map(([side, slot, v]) => `${side}${slot}@${frame - delay}[${v}]`).join(' '),
  );

test('a frame with no line applied neutral; the own slot is read from its L entry', () => {
  const sync = [
    tr(10, 2, [
      ['L', 0, '0,70,0'],
      ['R', 1, '0,0,0'],
    ]),
    tr(14, 2, [
      ['L', 0, '0,0,0'],
      ['R', 1, '4,0,0'],
    ]),
  ].join('\n');
  const own = appliedForTag(sync, 0);
  assert.equal(own.get(8), '0,70,0');
  assert.equal(own.get(9), '0,0,0');
  assert.equal(own.get(10), '0,0,0');
  assert.equal(appliedForTag(sync, 1).get(12), '4,0,0');
  assert.equal(own.delay, 2);
});

test('a joining page ran from the frame of its state, with or without a line', () => {
  const sync = [
    line(20, 'late-join loaded at frame 20'),
    tr(25, 3, [
      ['L', 2, '0,0,0'],
      ['R', 0, '0,70,0'],
    ]),
  ].join('\n');
  assert.equal(joinStateFrame(sync), 20);
  const host = appliedForTag(sync, 0);
  assert.equal(host.get(17), '0,0,0');
  assert.equal(host.get(22), '0,70,0');
});

test('pages that ran different inputs differ; a run a host state replaced is reported apart', () => {
  const host = [tr(20, 2, [['L', 0, '0,70,0']]), tr(21, 2, [['L', 0, '0,70,0']]), tr(90, 2, [['L', 0, '0,0,0']])].join(
    '\n',
  );
  const joiner = [
    line(20, 'late-join loaded at frame 20'),
    tr(21, 2, [['R', 0, '0,70,0']]),
    tr(90, 2, [['R', 0, '0,0,0']]),
  ].join('\n');
  const r = joinInputAgreement({
    pages: [
      { name: 'P1', sync: host },
      { name: 'P2', sync: joiner },
    ],
    slots: [0],
    from: 18,
    to: 40,
  });
  assert.equal(r.differingCount, 1);
  assert.deepEqual(r.differing[0], {
    slot: 0,
    tag: 18,
    P1: '0,70,0',
    P2: '0,0,0',
  });
  assert.equal(r.compared[0], 23);

  const reloaded = `${joiner}\n${line(60, 'sync frame reset: 60 → 50')}\n${tr(91, 2, [['R', 0, '0,0,0']])}`;
  const s = joinInputAgreement({
    pages: [
      { name: 'P1', sync: host },
      { name: 'P2', sync: reloaded },
    ],
    slots: [0],
    from: 18,
    to: 40,
  });
  assert.equal(s.differingCount, 0);
  assert.equal(s.supersededCount, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MASK_LEAD, changeInEffect, fileIndex, lateChange } from '../../web/src/controller-mask.ts';
import { createMaskSchedule, rosterMask } from '../../web/src/controller-mask-schedule.ts';
import { KNCore } from '../../web/src/index.ts';

test('the change in effect is the last one filed at or before the frame', () => {
  assert.equal(changeInEffect([], 5), -1);
  assert.equal(changeInEffect([10, 20], 9), -1);
  assert.equal(changeInEffect([10, 20], 10), 0);
  assert.equal(changeInEffect([10, 20], 19), 0);
  assert.equal(changeInEffect([10, 20], 20), 1);
  assert.equal(changeInEffect([10, 20], 1000), 1);
});

test('a change is filed before the first change at or after its frame', () => {
  assert.equal(fileIndex([], 5), 0);
  assert.equal(fileIndex([10, 20], 5), 0);
  assert.equal(fileIndex([10, 20], 10), 0);
  assert.equal(fileIndex([10, 20], 15), 1);
  assert.equal(fileIndex([10, 20], 25), 2);
});

test('a change is late only below the frontier and only if it changes the mask there', () => {
  assert.equal(lateChange(10, 10, 3, 7), false);
  assert.equal(lateChange(9, 10, 3, 7), true);
  assert.equal(lateChange(9, 10, 3, 3), false);
});

test('a roster mask is its slots, not the page that computes it', () => {
  assert.equal(rosterMask([0, 1]), 0b0011);
  assert.equal(rosterMask([0, 2, 3]), 0b1101);
  // A synthetic slot is left out outside the demo; invalid slots never count.
  assert.equal(rosterMask([0, 1], [1]), 0b0001);
  assert.equal(rosterMask([0, 4, -1, 1.5]), 0b0001);
});

test('a roster takes effect MASK_LEAD frames after its roster frame, on every page alike', () => {
  // arrivalOrderTest: the host files at its frame, the guest when the message
  // arrives frames later; both run every frame with the same mask.
  const host = createMaskSchedule();
  const guest = createMaskSchedule();
  host.start(0b0011, 0);
  guest.start(0b0011, 0);
  const hostFiled = host.fileRoster(100, 0b0111);
  for (let f = 0; f < 107; f++) host.ran(f);
  for (let f = 0; f < 104; f++) guest.ran(f);
  const guestFiled = guest.fileRoster(100, 0b0111);
  assert.equal(hostFiled.from, 100 + MASK_LEAD);
  assert.equal(guestFiled.from, 100 + MASK_LEAD);
  assert.equal(hostFiled.late, false);
  assert.equal(guestFiled.late, false);
  for (let f = 0; f < 300; f++) assert.equal(host.maskAt(f), guest.maskAt(f), `frame ${f}`);
  assert.equal(host.maskAt(100 + MASK_LEAD - 1), 0b0011);
  assert.equal(host.maskAt(100 + MASK_LEAD), 0b0111);
});

test('a frame run again uses the mask it used the first time', () => {
  // rollbackAcrossTheChangeTest: frames run, a roster arrives, a rollback
  // takes the page back over frames before it: they keep their mask.
  const page = createMaskSchedule();
  page.start(0b0011, 0);
  const first: number[] = [];
  for (let f = 0; f < 50; f++) {
    first.push(page.maskAt(f));
    page.ran(f);
  }
  page.fileRoster(48, 0b0001);
  for (let f = 40; f < 50; f++) assert.equal(page.maskAt(f), first[f]);
});

test('the host broadcasting twice at one frame: the later roster wins', () => {
  const page = createMaskSchedule();
  page.start(0b0011, 0);
  page.fileRoster(10, 0b0111);
  page.fileRoster(10, 0b1111);
  assert.equal(page.maskAt(10 + MASK_LEAD), 0b1111);
  assert.equal(page.wireFrom(0).changes.length, 1);
  // The same roster heard again (the host's resend on a channel open) is no change.
  const again = page.fileRoster(10, 0b1111);
  assert.equal(again.late, false);
  assert.equal(again.maskBefore, 0b1111);
});

test('a roster heard after the page ran past its frame is late, and filed at the agreed frame', () => {
  // lateArrivalTest.
  const page = createMaskSchedule(3);
  page.start(0b0011, 0);
  for (let f = 0; f < 5; f++) page.ran(f);
  const filed = page.fileRoster(0, 0b0111);
  assert.equal(filed.from, 3);
  assert.equal(filed.late, true);
  assert.equal(page.maskAt(3), 0b0111);
  // Late but no different from what ran: nothing to repair.
  const same = createMaskSchedule(3);
  same.start(0b0011, 0);
  for (let f = 0; f < 5; f++) same.ran(f);
  assert.equal(same.fileRoster(0, 0b0011).late, false);
});

test('a late joiner takes the host schedule from the state frame on', () => {
  const host = createMaskSchedule();
  host.start(0b0011, 0);
  host.fileRoster(10, 0b0001);
  host.fileRoster(500, 0b0111);
  const wire = host.wireFrom(300);
  assert.deepEqual(wire, { base: 0b0001, changes: [[500, 500 + MASK_LEAD, 0b0111]] });
  const joiner = createMaskSchedule();
  assert.equal(joiner.adopt(JSON.parse(JSON.stringify(wire)), 300), true);
  for (let f = 300; f < 700; f++) assert.equal(joiner.maskAt(f), host.maskAt(f), `frame ${f}`);
  assert.equal(joiner.frontier(), 300);
  assert.equal(joiner.lastRosterFrame(), 500);
});

test('a malformed schedule is refused and changes nothing', () => {
  const page = createMaskSchedule();
  for (const wire of [
    null,
    { base: 0, changes: [] },
    { base: 3, changes: 'x' },
    { base: 3, changes: [[1, 2]] },
    { base: 3, changes: [[1, 50, 3]] }, // at or before the state's frame
    {
      base: 3,
      changes: [
        [1, 400, 3],
        [2, 400, 7],
      ],
    }, // not increasing
    { base: 3, changes: [[1, 400, 16]] },
  ]) {
    assert.equal(page.adopt(wire, 100), false);
  }
  assert.equal(page.active(), false);
});

test('a local change (the demo toggle) takes effect at the next frame not yet run', () => {
  const page = createMaskSchedule();
  page.start(0b0001, 0);
  for (let f = 0; f < 20; f++) page.ran(f);
  page.ran(5); // a replay frame does not move the frontier back
  const filed = page.fileLocal(0b0011);
  assert.equal(filed.from, 20);
  assert.equal(filed.late, false);
  assert.equal(page.maskAt(19), 0b0001);
  assert.equal(page.maskAt(20), 0b0011);
  assert.equal(page.lastRosterFrame(), -1);
});

test('stop clears the schedule', () => {
  const page = createMaskSchedule();
  page.start(0b0011, 0);
  page.fileRoster(0, 0b0111);
  page.stop();
  assert.equal(page.active(), false);
  assert.equal(page.lastRosterFrame(), -1);
});

test('the engine reaches the rules through KNCore', () => {
  assert.equal(KNCore.controllerMask.MASK_LEAD, MASK_LEAD);
  assert.equal(typeof KNCore.controllerMask.createMaskSchedule, 'function');
  assert.equal(KNCore.controllerMask.rosterMask([0, 1]), 3);
});

test('a match is scheduled only while it was and every other player page can', () => {
  const { matchScheduled } = KNCore.controllerMask;
  assert.equal(matchScheduled(true, []), true);
  assert.equal(matchScheduled(true, [true, true]), true);
  assert.equal(matchScheduled(true, [true, false]), false);
  // Once immediate, immediate for the rest of the match.
  assert.equal(matchScheduled(false, [true, true]), false);
});

test('a guest schedules only a roster the host announced, while it has not fallen back', () => {
  const { rosterScheduled } = KNCore.controllerMask;
  assert.equal(rosterScheduled(true, 100, 100), true);
  assert.equal(rosterScheduled(true, -1, 100), false);
  assert.equal(rosterScheduled(true, 99, 100), false);
  assert.equal(rosterScheduled(false, 100, 100), false);
});

test('only caps that name the capability count; none or malformed is an old page', () => {
  const { canScheduleMask, MASK_CAP } = KNCore.controllerMask;
  assert.equal(canScheduleMask({ [MASK_CAP]: true }), true);
  assert.equal(canScheduleMask({ [MASK_CAP]: 1 }), false);
  assert.equal(canScheduleMask({ trueRollback: true }), false);
  assert.equal(canScheduleMask(undefined), false);
  assert.equal(canScheduleMask(null), false);
  assert.equal(canScheduleMask([true]), false);
});

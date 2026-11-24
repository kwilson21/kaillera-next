import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { MatchReturn } from '../../web/src/play/match-return.ts';
import { MatchReturn as PreviousMatchReturn } from './fixtures/match-return.old.ts';

const setup = () => {
  const reports: boolean[] = [];
  return { room: new MatchReturn('next', 'previous', (ready) => reports.push(ready)), reports };
};

test('an installed seat reports once and waits for a grant for its own match', async () => {
  const { room, reports } = setup();
  assert.equal(room.needsInstall, true);
  const gate = room.ready();
  assert.equal(room.ready(), gate);
  assert.equal(room.needsInstall, false);
  room.finish('previous', true);
  assert.equal(room.playing, false);
  room.finish('next', true);
  assert.equal(await gate, true);
  assert.equal(room.playing, true);
  assert.equal(room.startEngine('next'), null);
  assert.deepEqual(reports, [true]);
});

test('an early room grant preserves the source save until the engine installs it', async () => {
  const { room, reports } = setup();
  room.finish('next', true);
  await nextTurn();
  assert.equal(await Promise.race([room.released, Promise.resolve('waiting')]), 'waiting');
  assert.equal(room.needsInstall, true);
  assert.equal(await room.ready(), true);
  assert.deepEqual(reports, []);
});

test('a replaced engine in a pending match must install its own copy before playing', async () => {
  const { room, reports } = setup();
  const first = room.ready();
  assert.equal(room.startEngine('previous'), null);
  assert.equal(room.needsInstall, false);
  assert.equal(room.startEngine('next'), room);
  room.finish('next', true);
  assert.equal(room.needsInstall, true);
  assert.equal(room.playing, false);
  assert.equal(await room.ready(), true);
  assert.equal(await first, true);
  assert.deepEqual(reports, [true]);
});

test('engine failure reports once and wins over a late room grant', async () => {
  const { room, reports } = setup();
  room.finish('next', true);
  assert.equal(room.fail(), true);
  assert.equal(room.fail(), false);
  room.finish('next', true);
  assert.equal(await room.ready(), false);
  assert.equal(room.needsInstall, false);
  assert.deepEqual(reports, [false]);
});

test('a room cancellation settles installed engines without reporting a local failure', async () => {
  const { room, reports } = setup();
  const gate = room.ready();
  room.finish('next', false);
  room.finish('next', true);
  assert.equal(await gate, false);
  assert.equal(room.fail(), false);
  assert.deepEqual(reports, [true]);
});

test('the old and new release gates agree on ordinary traces and differ on the modeled early grant', async () => {
  const cases = [
    { events: ['install', 'install', 'stale'], previous: 'waiting', current: 'waiting' },
    { events: ['install', 'grant', 'cancel'], previous: true, current: true },
    { events: ['install', 'cancel', 'grant'], previous: false, current: false },
    { events: ['grant'], previous: true, current: 'waiting' },
    { events: ['grant', 'install'], previous: true, current: true },
    { events: ['grant', 'cancel', 'install'], previous: true, current: false },
  ];
  for (const { events, previous, current } of cases) {
    const old = new PreviousMatchReturn('next', 'previous');
    const oldReports: boolean[] = [];
    const { room, reports } = setup();
    for (const event of events) {
      if (event === 'install') {
        void old.ready(() => oldReports.push(true));
        void room.ready();
      } else {
        const epoch = event === 'stale' ? 'previous' : 'next';
        old.finish(epoch, event !== 'cancel');
        room.finish(epoch, event !== 'cancel');
      }
    }
    await nextTurn();
    assert.equal(await Promise.race([old.released, Promise.resolve('waiting')]), previous, events.join(' '));
    assert.equal(await Promise.race([room.released, Promise.resolve('waiting')]), current, events.join(' '));
    assert.deepEqual(reports, oldReports, events.join(' '));
  }
});

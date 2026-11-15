/**
 * Who a page waits for before its match runs (web/src/start-group.ts,
 * specs/start_group.qnt), over every input the decisions take.
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import { startDeadline } from '../../web/src/start-deadline.ts';
import {
  countedByStartGates,
  leavesOut,
  leavesOutUnreachable,
  leftOutItself,
  missedLoadDeadline,
  rejoinsLate,
  startHasItsHost,
  startsAlone,
  takesLeftOut,
} from '../../web/src/start-group.ts';

const BOOLS = [false, true] as const;
const SLOTS = [-1, 0, 1, 2, 3, 4] as const;

test('a player left out, or held as a late joiner, is counted by no start wait', () => {
  for (const isPlayer of BOOLS)
    for (const held of BOOLS)
      for (const leftOut of BOOLS) {
        const counted = countedByStartGates(isPlayer, held, leftOut);
        assert.equal(counted, isPlayer && !held && !leftOut, `${isPlayer} ${held} ${leftOut}`);
        if (leftOut) assert.equal(counted, false);
      }
});

test('only the host leaves a player out, before its match runs; one that answered only for missing the load deadline', () => {
  for (const isHost of BOOLS)
    for (const running of BOOLS)
      for (const other of BOOLS)
        for (const open of BOOLS)
          for (const missed of BOOLS)
            for (const out of BOOLS) {
              const leaves = leavesOut(isHost, running, other, open, missed, out);
              assert.equal(leaves, isHost && !running && other && !out && (!open || missed));
              if (leaves && open) assert.equal(missed, true);
            }
  // A guest whose deadline gave up waits for the host's word.
  assert.equal(leavesOut(false, false, true, false, false, false), false);
  // A player that answered and is loading is in.
  assert.equal(leavesOut(true, false, true, true, false, false), false);
});

test('at the load deadline a player missed it if it has not loaded, or the host is at the ready barrier and it is not', () => {
  for (const emuReady of BOOLS)
    for (const hostSaidReady of BOOLS)
      for (const saidReady of BOOLS) {
        const missed = missedLoadDeadline(emuReady, hostSaidReady, saidReady);
        assert.equal(missed, !emuReady || (hostSaidReady && !saidReady), `${emuReady} ${hostSaidReady} ${saidReady}`);
      }
  // A page from before `left-out:` that loaded but waits for a player the
  // host left out: it never reaches the barrier the host has reached.
  assert.equal(missedLoadDeadline(true, true, false), true);
  // While the host is still syncing itself, a player that loaded is not cut.
  assert.equal(missedLoadDeadline(true, false, false), false);
});

test('the host leaves out the guest another guest cannot reach, both in the start, once a give-up could have come', () => {
  const GIVE_UP = 24000;
  for (const isHost of BOOLS)
    for (const running of BOOLS)
      for (const from of SLOTS)
        for (const slot of SLOTS)
          for (const reporterIn of BOOLS)
            for (const namedIn of BOOLS)
              for (const since of [0, GIVE_UP - 1, GIVE_UP, 60000]) {
                const leaves = leavesOutUnreachable(isHost, running, from, slot, reporterIn, namedIn, since, GIVE_UP);
                const expected =
                  isHost &&
                  !running &&
                  reporterIn &&
                  namedIn &&
                  since >= GIVE_UP &&
                  from > 0 &&
                  from < 4 &&
                  slot > 0 &&
                  slot < 4 &&
                  from !== slot;
                assert.equal(leaves, expected, `${isHost} ${running} ${from} ${slot} ${reporterIn} ${namedIn} ${since}`);
              }
  // Slot 1 says it cannot reach slot 2: slot 2 is out. Slot 2 then says the
  // same of slot 1: it is out of the start itself, so its word does not count.
  assert.equal(leavesOutUnreachable(true, false, 1, 2, true, true, GIVE_UP, GIVE_UP), true);
  assert.equal(leavesOutUnreachable(true, false, 2, 1, false, true, GIVE_UP, GIVE_UP), false);
  // A claim made at once is not taken: no deadline could have given up yet.
  assert.equal(leavesOutUnreachable(true, false, 1, 2, true, true, 1000, GIVE_UP), false);
  // Never the host, never from the host, never the sender itself.
  assert.equal(leavesOutUnreachable(true, false, 1, 0, true, true, GIVE_UP, GIVE_UP), false);
  assert.equal(leavesOutUnreachable(true, false, 0, 1, true, true, GIVE_UP, GIVE_UP), false);
  assert.equal(leavesOutUnreachable(true, false, 1, 1, true, true, GIVE_UP, GIVE_UP), false);
});

test('a guest told by the host that it is out joins late; nobody else can tell it so', () => {
  for (const from of SLOTS)
    for (const mine of SLOTS)
      for (const slot of SLOTS)
        for (const running of BOOLS)
          for (const lateJoin of BOOLS) {
            const out = leftOutItself(from, mine, running, slot, lateJoin);
            const expected = from === 0 && mine > 0 && mine < 4 && slot === mine && !running && !lateJoin;
            assert.equal(
              out,
              expected,
              `from=${from} mine=${mine} slot=${slot} running=${running} lateJoin=${lateJoin}`,
            );
          }
  // takesLeftOut is for the others: never a page's own slot.
  assert.equal(takesLeftOut(0, 2, false, 2, false), false);
});

test('the host starts alone only with nobody left in its start group', () => {
  assert.equal(startsAlone(true, false, 0), true);
  assert.equal(startsAlone(true, false, 1), false);
  assert.equal(startsAlone(true, true, 0), false);
  assert.equal(startsAlone(false, false, 0), false);
});

test("a guest takes left-out only from the host's channel, for another guest's slot", () => {
  for (const from of SLOTS)
    for (const mine of SLOTS)
      for (const slot of SLOTS)
        for (const running of BOOLS)
          for (const out of BOOLS) {
            const takes = takesLeftOut(from, mine, running, slot, out);
            const expected =
              from === 0 && mine > 0 && mine < 4 && !running && !out && slot > 0 && slot < 4 && slot !== mine;
            assert.equal(takes, expected, `from=${from} mine=${mine} slot=${slot} running=${running} out=${out}`);
          }
  // Another guest's word, or one to the host, is not taken.
  assert.equal(takesLeftOut(2, 1, false, 3, false), false);
  assert.equal(takesLeftOut(0, 0, false, 1, false), false);
  // A spectator (-1) waits for nobody.
  assert.equal(takesLeftOut(0, -1, false, 1, false), false);
  // The host never leaves itself out.
  assert.equal(takesLeftOut(0, 1, false, 0, false), false);
});

test('a guest goes on with its start only with its channel to the host open', () => {
  for (const isHost of BOOLS)
    for (const open of BOOLS) assert.equal(startHasItsHost(isHost, open), isHost || open, `${isHost} ${open}`);
  assert.equal(startHasItsHost(false, false), false);
});

test('a guest with no channel to the host by its deadline joins late, unless it is joining late already', () => {
  assert.equal(rejoinsLate(false, false, false, false), true);
  assert.equal(rejoinsLate(false, false, false, true), false);
  assert.equal(rejoinsLate(false, false, true, false), false);
  assert.equal(rejoinsLate(false, true, false, false), false);
  assert.equal(rejoinsLate(true, false, false, false), false);
});

test('KNCore gives the engine the start group decisions', () => {
  assert.equal(KNCore.startGroup.countedByStartGates, countedByStartGates);
  assert.equal(KNCore.startGroup.leavesOut, leavesOut);
  assert.equal(KNCore.startGroup.startsAlone, startsAlone);
  assert.equal(KNCore.startGroup.takesLeftOut, takesLeftOut);
  assert.equal(KNCore.startGroup.rejoinsLate, rejoinsLate);
  assert.equal(KNCore.startGroup.leftOutItself, leftOutItself);
  assert.equal(KNCore.startGroup.leavesOutUnreachable, leavesOutUnreachable);
  assert.equal(KNCore.startGroup.missedLoadDeadline, missedLoadDeadline);
  assert.equal(KNCore.startGroup.startHasItsHost, startHasItsHost);
  assert.equal(KNCore.startGroup.startDeadline, startDeadline);
});

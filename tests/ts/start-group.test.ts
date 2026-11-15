/**
 * Who a page waits for before its match runs (web/src/start-group.ts,
 * specs/start_group.qnt), over every input the decisions take.
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import { countedByStartGates, leavesOut, rejoinsLate, startsAlone, takesLeftOut } from '../../web/src/start-group.ts';

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

test('only the host leaves a player out, before its match runs, and never one whose channel is open', () => {
  for (const isHost of BOOLS)
    for (const running of BOOLS)
      for (const other of BOOLS)
        for (const open of BOOLS)
          for (const out of BOOLS) {
            const leaves = leavesOut(isHost, running, other, open, out);
            assert.equal(leaves, isHost && !running && other && !open && !out);
          }
  // A guest whose deadline gave up waits for the host's word.
  assert.equal(leavesOut(false, false, true, false, false), false);
});

test('the host starts alone only with nobody left in its start group', () => {
  assert.equal(startsAlone(true, false, 0), true);
  assert.equal(startsAlone(true, false, 1), false);
  assert.equal(startsAlone(true, true, 0), false);
  assert.equal(startsAlone(false, false, 0), false);
});

test("a guest takes left-out only from the host's channel, for a slot other than its own", () => {
  for (const from of SLOTS)
    for (const mine of SLOTS)
      for (const slot of SLOTS)
        for (const running of BOOLS)
          for (const out of BOOLS) {
            const takes = takesLeftOut(from, mine, running, slot, out);
            const expected =
              from === 0 && mine > 0 && mine < 4 && !running && !out && slot >= 0 && slot < 4 && slot !== mine;
            assert.equal(takes, expected, `from=${from} mine=${mine} slot=${slot} running=${running} out=${out}`);
          }
  // Another guest's word, or one to the host, is not taken.
  assert.equal(takesLeftOut(2, 1, false, 3, false), false);
  assert.equal(takesLeftOut(0, 0, false, 1, false), false);
  // A spectator (-1) waits for nobody.
  assert.equal(takesLeftOut(0, -1, false, 1, false), false);
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
});
